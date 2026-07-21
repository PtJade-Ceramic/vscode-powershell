// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SemVer } from "semver";
import vscode = require("vscode");

import type { ILogger } from "../logging";
import type { IPowerShellVersionDetails } from "../session";
import { changeSetting, Settings } from "../settings";

interface IUpdateMessageItem extends vscode.MessageItem {
    id: number;
}

async function fetchJSON<T>(url: string): Promise<T | undefined> {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return response.json();
}

/** Strip the 4th component from a WinGet version (e.g. "7.4.5.0" → "7.4.5"). */
function toTriple(v: string): string {
    return v.split(".").slice(0, 3).join(".");
}

/** Await a value/promise, and if non-nullish, pass it to `fn`. */
async function whenSome<T>(
    value: T | undefined | null | Promise<T | undefined | null>,
    fn: (value: T) => void | Promise<void>,
): Promise<void> {
    const resolved = await value;
    if (resolved != null) await fn(resolved);
}

// This attempts to mirror PowerShell's `UpdatesNotification.cs` logic as much as
// possibly, documented at:
// https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_update_notifications
export class UpdatePowerShell {
    private localVersion: SemVer;

    constructor(
        private sessionSettings: Settings,
        private logger: ILogger,
        versionDetails: IPowerShellVersionDetails,
    ) {
        // We use the commit field as it's like
        // '7.3.0-preview.3-508-g07175ae0ff8eb7306fe0b0fc7d...' which translates
        // to SemVer. The version handler in PSES handles Windows PowerShell and
        // just returns the first three fields like '5.1.22621'.
        this.localVersion = new SemVer(versionDetails.commit);
    }

    private skip(reason: string): false {
        this.logger.writeDebug(reason);
        return false;
    }

    private shouldCheckForUpdate(): boolean {
        // Respect user setting.
        if (!this.sessionSettings.promptToUpdatePowerShell)
            return this.skip("Setting 'promptToUpdatePowerShell' was false.");

        // Respect environment configuration.
        if (process.env.POWERSHELL_UPDATECHECK?.toLowerCase() === "off")
            return this.skip("Environment variable 'POWERSHELL_UPDATECHECK' was 'Off'.");

        // Skip prompting when using Windows PowerShell for now.
        if (this.localVersion.compare("6.0.0") === -1)
            // TODO: Maybe we should announce PowerShell Core?
            return this.skip("Not prompting to update Windows PowerShell.");

        if (this.localVersion.prerelease.length > 1) {
            // Daily builds look like '7.3.0-daily20221206.1' which split to
            // ['daily20221206', '1'] and development builds look like
            // '7.3.0-preview.3-508-g07175...' which splits to ['preview',
            // '3-508-g0717...']. The ellipsis is hiding a 40 char hash.
            // Skip if PowerShell is self-built, that is, this contains a commit hash.
            if (this.localVersion.prerelease[1].toString().length >= 40)
                return this.skip("Not prompting to update development build.");

            // Skip if preview is a daily build.
            if (this.localVersion.prerelease[0].toString().toLowerCase().startsWith("daily"))
                return this.skip("Not prompting to update daily build.");
        }

        // TODO: Check if network is available?
        // TODO: Only check once a week.
        return true;
    }

    private async getRemoteVersion(url: string): Promise<string | undefined> {
        const data = await fetchJSON<{
            ReleaseTag: string;
        }>(url);
        if (!data) return undefined;
        this.logger.writeDebug(
            `Received from '${url}':\n${JSON.stringify(data, undefined, 2)}`,
        );
        return data.ReleaseTag;
    }

    private async maybeGetNewRelease(): Promise<string | undefined> {
        if (!this.shouldCheckForUpdate()) {
            return undefined;
        }

        this.logger.writeDebug("Checking for PowerShell update...");
        const suffixes = process.env.POWERSHELL_UPDATECHECK?.toLowerCase() === "lts"
            ? ["lts"]
            : this.localVersion.prerelease.length > 0
                ? ["stable", "preview"]
                : ["stable"];
        this.logger.writeDebug(`Checking for ${suffixes.join(" and ")} update...`);
        for (const tag of await Promise.all(
            suffixes.map(s => this.getRemoteVersion(`https://aka.ms/pwsh-buildinfo-${s}`)),
        )) {
            if (tag != undefined && this.localVersion.compare(tag) === -1) {
                return tag;
            }
        }

        this.logger.write("PowerShell is up-to-date.");
        return undefined;
    }

    public async checkForUpdate(): Promise<void> {
        try {
            await whenSome(this.maybeGetNewRelease(), tag => this.promptToUpdate(tag));
        } catch (err) {
            // Best effort. This probably failed to fetch the data from GitHub.
            this.logger.writeWarning(
                err instanceof Error ? err.message : "unknown",
            );
        }
    }

    private async openReleaseInBrowser(tag: string): Promise<void> {
        await vscode.env.openExternal(
            vscode.Uri.parse(`https://github.com/PowerShell/PowerShell/releases/tag/${tag}`),
        );
    }

    private async promptToUpdate(tag: string): Promise<void> {
        const releaseVersion = new SemVer(tag);
        this.logger.write(
            `Prompting to update PowerShell v${this.localVersion.version} to v${releaseVersion.version}.`,
        );

        // Dynamically build prompt options: add WinGet button if it has this version.
        const options: IUpdateMessageItem[] = [];
        let wingetIndex = -1;
        let wingetStatusIndex = -1;
        let browserIndex: number;
        let notNowIndex: number;
        let dontShowIndex: number;

        // Check WinGet availability and version on Windows.
        const isWindows = process.platform === "win32";
        let wingetVer: string | undefined;
        let wingetInstalled = false;
        if (isWindows) {
            try {
                const { execFile } = await import("node:child_process");
                await whenSome(
                    new Promise<string>((resolve, reject) => {
                        execFile(
                            "winget",
                            ["show", "--id", "Microsoft.PowerShell", "-s", "winget", "--accept-source-agreements"],
                            (error: any, stdout: any) => error ? reject(error) : resolve(stdout),
                        );
                    }).then(s => s.match(/Version:\s*([\d.]+)/)),
                    match => {
                        wingetVer = toTriple(match[1]);
                        wingetInstalled = true;
                    },
                );
            } catch {
                // WinGet may not be installed — fall back to GitHub API.
                try {
                    await whenSome(
                        fetchJSON<Array<Record<string, string>>>(
                            "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/m/Microsoft/PowerShell?per_page=100",
                        ),
                        entries => this.logger.writeDebug(
                            `WinGet repo latest: ${(wingetVer = entries
                                .filter(({ type }) => type === "dir")
                                .map(({ name }) => toTriple(name))
                                .sort((a, b) => new SemVer(b).compare(a))[0]) ?? "not found"}`,
                        ),
                    );
                } catch {
                    // Best effort.
                }
            }
        }

        const addButton = (title: string): number => {
            const idx = options.length;
            options.push({ id: idx, title });
            return idx;
        };

        // Show WinGet button: "Upgrade with WinGet" when useful,
        // "Install WinGet" when not detected on Windows.
        let wingetAction: "upgrade" | "install" | undefined;
        if (
            wingetVer &&
            wingetInstalled &&
            new SemVer(wingetVer).compare(this.localVersion) > 0
        ) {
            wingetAction = "upgrade";
        } else if (!wingetInstalled && isWindows) {
            wingetAction = "install";
        }
        if (wingetAction)
            wingetIndex = addButton(wingetAction === "install" ? "Install WinGet" : "Upgrade with WinGet");
        if (
            wingetInstalled &&
            wingetVer &&
            new SemVer(wingetVer).compare(releaseVersion.version) < 0
        ) {
            wingetStatusIndex = addButton("Check WinGet Status");
        }

        [browserIndex, notNowIndex, dontShowIndex] =
            ["Open GitHub Release", "Not Now", "Don't Show Again"].map(addButton);

        // Build message with WinGet status when relevant.
        let message =
            `PowerShell v${this.localVersion.version} is out-of-date.
            The latest version is v${releaseVersion.version}.`;
        if (wingetInstalled) {
            message +=
                new SemVer(wingetVer!).compare(this.localVersion) <= 0
                    ? `\n(WinGet hasn't caught up yet — currently v${wingetVer}.)`
                    : new SemVer(wingetVer!).compare(
                        releaseVersion.version,
                    ) < 0
                        ? `\n(WinGet currently has v${wingetVer}.)`
                        : "";
        } else if (isWindows) {
            message += wingetVer
                ? `\n(WinGet is not installed. It offers v${wingetVer}.)`
                : `\n(WinGet, the Windows Package Manager, is not installed.)`;
        }
        message += `\nWould you like to upgrade?`;

        const result = await vscode.window.showInformationMessage(
            message,
            ...options,
        );

        // If the user cancels the notification.
        if (!result) {
            this.logger.writeDebug("User canceled PowerShell update prompt.");
            return;
        }

        this.logger.writeDebug(
            `User said '${options[result.id].title}'.`,
        );

        switch (result.id) {
            case wingetIndex:
                if (wingetAction === "install") {
                    // From: https://aka.ms/winget-docs
                    this.logger.write("Installing WinGet and upgrading PowerShell...");
                    vscode.window.createTerminal("Install WinGet & Upgrade PowerShell")
                        .sendText(
                            "$result = Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction SilentlyContinue; if ($?) { winget update --id Microsoft.PowerShell -e -s winget } else { Write-Warning 'Failed to install WinGet. See https://aka.ms/winget-docs' }",
                        );
                } else {
                    this.logger.write("Upgrading PowerShell via WinGet...");
                    vscode.window.createTerminal("PowerShell Upgrade (WinGet)")
                        .sendText("winget update --id Microsoft.PowerShell -e -s winget");
                }
                break;
            case wingetStatusIndex: {
                // Find the open issue/PR mentioning the highest PowerShell version.
                let statusUrl =
                    "https://github.com/microsoft/winget-pkgs/pulls?q=Microsoft.PowerShell+is:open";
                try {
                    const parsed = await Promise.all(
                        (
                            (await fetchJSON<{
                                items?: Array<{
                                    title: string;
                                    html_url: string;
                                    pull_request?: unknown;
                                }>;
                            }>(
                                "https://api.github.com/search/issues?q=Microsoft.PowerShell+repo:microsoft/winget-pkgs+is:open&sort=created&order=desc&per_page=30",
                            ))?.items ?? []
                        ).map(
                            async (
                                item,
                            ): Promise<
                                typeof item & { ver?: string }
                            > => {
                                const tm = item.title.match(
                                    /(?:New version|Update|\[Update Request\]).*?(\d+\.\d+\.\d+)/i,
                                );
                                if (tm) return { ...item, ver: tm[1] };
                                // Try to extract version from the issue body.
                                try {
                                    const bm = (
                                        await fetchJSON<{
                                            body?: string;
                                        }>(
                                            item.html_url.replace(
                                                "https://github.com/",
                                                "https://api.github.com/repos/",
                                            ),
                                        )
                                    )?.body?.match(
                                        /Package Version.*?(\d+\.\d+\.\d+)/i,
                                    );
                                    if (bm) {
                                        return { ...item, ver: bm[1] };
                                    }
                                } catch {
                                    // Best effort.
                                }
                                return item;
                            },
                        ),
                    );

                    let bestPR: string | undefined;
                    let bestIssue: string | undefined;
                    let bestPRVer: string | undefined;
                    let bestIssueVer: string | undefined;
                    for (const {
                        ver,
                        html_url,
                        pull_request,
                    } of parsed) {
                        if (!ver) continue;
                        if (pull_request) {
                            if (
                                !bestPRVer ||
                                new SemVer(ver).compare(bestPRVer) > 0
                            ) {
                                bestPRVer = ver;
                                bestPR = html_url;
                            }
                        } else {
                            if (
                                !bestIssueVer ||
                                new SemVer(ver).compare(bestIssueVer) > 0
                            ) {
                                bestIssueVer = ver;
                                bestIssue = html_url;
                            }
                        }
                    }
                    // Prefer issue when linked to the PR for the same version.
                    const prVer = bestPRVer
                        ? new SemVer(bestPRVer)
                        : undefined;
                    const issueVer = bestIssueVer
                        ? new SemVer(bestIssueVer)
                        : undefined;
                    if (
                        prVer && issueVer &&
                        prVer.compare(issueVer) === 0
                    ) {
                        statusUrl = bestIssue!;
                    } else if (
                        prVer &&
                        (!issueVer || prVer.compare(issueVer) > 0)
                    ) {
                        statusUrl = bestPR!;
                    } else if (issueVer) {
                        statusUrl = bestIssue!;
                    }
                } catch {
                    // Fall back to generic search.
                }
                await vscode.env.openExternal(vscode.Uri.parse(statusUrl));
                break;
            }
            case browserIndex:
                await this.openReleaseInBrowser(tag);
                break;
            case notNowIndex:
                // Do nothing.
                break;
            case dontShowIndex:
                await changeSetting(
                    "promptToUpdatePowerShell",
                    false,
                    true,
                    this.logger,
                );
                break;
            default:
                break;
        }
    }
}
