import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitInfo {
	branch?: string;
	changedFiles: string[];
	error?: string;
}

export async function getGitInfo(cwd: string = process.cwd()): Promise<GitInfo> {
	try {
		const [{ stdout: branchOut }, { stdout: statusOut }] = await Promise.all([
			execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
			execFileAsync("git", ["status", "--porcelain"], { cwd }),
		]);
		const branch = branchOut.trim() || undefined;
		const changedFiles = statusOut
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		return { branch, changedFiles };
	} catch (error) {
		return { changedFiles: [], error: error instanceof Error ? error.message : String(error) };
	}
}

export function formatGitInfoLines(git: GitInfo, maxFiles = 20): string[] {
	const lines: string[] = [];
	if (git.error) {
		lines.push(`Git: unavailable (${git.error})`);
		return lines;
	}
	lines.push(`Git branch: ${git.branch ?? "unknown"}`);
	if (git.changedFiles.length === 0) {
		lines.push("Changed files: none");
		return lines;
	}
	const shown = git.changedFiles.slice(0, maxFiles);
	lines.push(`Changed files (${git.changedFiles.length}):`);
	for (const file of shown) lines.push(`  ${file}`);
	if (git.changedFiles.length > maxFiles) {
		lines.push(`  …and ${git.changedFiles.length - maxFiles} more`);
	}
	return lines;
}
