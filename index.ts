#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Maximum number of search results to return
const SEARCH_LIMIT = 200;

interface Config {
	obsidianVaultPath: string;
}

// Configuration from environment variables
const config: Config = {
	obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH || "",
};

if (!config.obsidianVaultPath) {
	console.error("Error: OBSIDIAN_VAULT_PATH environment variable is required");
	process.exit(1);
}

// Store allowed directories in normalized form
const vaultDirectories = [
	normalizePath(path.resolve(expandHome(config.obsidianVaultPath))),
];

// Normalize all paths consistently
function normalizePath(p: string): string {
	return path.normalize(p).toLowerCase();
}

function expandHome(filepath: string): string {
	if (filepath.startsWith("~/") || filepath === "~") {
		return path.join(os.homedir(), filepath.slice(1));
	}
	return filepath;
}

// Validate that all directories exist and are accessible
await Promise.all(
	vaultDirectories.map(async (dir) => {
		try {
			const stats = await fs.stat(dir);
			if (!stats.isDirectory()) {
				console.error(`Error: ${dir} is not a directory`);
				process.exit(1);
			}
		} catch (error) {
			console.error(`Error accessing directory ${dir}:`, error);
			process.exit(1);
		}
	}),
);

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
	// Ignore hidden files/directories starting with "."
	const pathParts = requestedPath.split(path.sep);
	if (pathParts.some((part) => part.startsWith("."))) {
		throw new Error("Access denied - hidden files/directories not allowed");
	}

	const expandedPath = expandHome(requestedPath);
	const absolute = path.isAbsolute(expandedPath)
		? path.resolve(expandedPath)
		: path.resolve(process.cwd(), expandedPath);

	const normalizedRequested = normalizePath(absolute);

	// Check if path is within allowed directories
	const isAllowed = vaultDirectories.some((dir) =>
		normalizedRequested.startsWith(dir),
	);
	if (!isAllowed) {
		throw new Error(
			`Access denied - path outside allowed directories: ${absolute} not in ${vaultDirectories.join(
				", ",
			)}`,
		);
	}

	// Handle symlinks by checking their real path
	try {
		const realPath = await fs.realpath(absolute);
		const normalizedReal = normalizePath(realPath);
		const isRealPathAllowed = vaultDirectories.some((dir) =>
			normalizedReal.startsWith(dir),
		);
		if (!isRealPathAllowed) {
			throw new Error(
				"Access denied - symlink target outside allowed directories",
			);
		}
		return realPath;
	} catch (error) {
		// For new files that don't exist yet, verify parent directory
		const parentDir = path.dirname(absolute);
		try {
			const realParentPath = await fs.realpath(parentDir);
			const normalizedParent = normalizePath(realParentPath);
			const isParentAllowed = vaultDirectories.some((dir) =>
				normalizedParent.startsWith(dir),
			);
			if (!isParentAllowed) {
				throw new Error(
					"Access denied - parent directory outside allowed directories",
				);
			}
			return absolute;
		} catch {
			throw new Error(`Parent directory does not exist: ${parentDir}`);
		}
	}
}

// Schema definitions
const ReadNotesArgsSchema = z.object({
	paths: z.array(z.string()),
});

const SearchNotesArgsSchema = z.object({
	query: z.string(),
});

const ReadNotesDirArgsSchema = z.object({
	path: z.string(),
});

const WriteNoteArgsSchema = z.object({
	path: z.string(),
	content: z.string(),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Server setup
const server = new Server(
	{
		name: "mcp-obsidian",
		version: "1.0.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
);

/**
 * Search for notes in the allowed directories that match the query.
 * @param query - The query to search for.
 * @returns An array of relative paths to the notes (from root) that match the query.
 */
async function searchNotes(query: string): Promise<string[]> {
	const results: string[] = [];

	async function search(basePath: string, currentPath: string) {
		const entries = await fs.readdir(currentPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(currentPath, entry.name);

			try {
				// Validate each path before processing
				await validatePath(fullPath);

				let matches = entry.name.toLowerCase().includes(query.toLowerCase());
				try {
					matches =
						matches ||
						new RegExp(query.replace(/[*]/g, ".*"), "i").test(entry.name);
				} catch {
					// Ignore invalid regex
				}

				if (entry.name.endsWith(".md") && matches) {
					// Turn into relative path
					results.push(fullPath.replace(basePath, ""));
				}

				if (entry.isDirectory()) {
					await search(basePath, fullPath);
				}
			} catch (error) {
				// Skip invalid paths during search
				console.error(`Error searching ${fullPath}:`, error);
			}
		}
	}

	await Promise.all(vaultDirectories.map((dir) => search(dir, dir)));
	return results;
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
	const tools = [
		{
			name: "obsidian_read_notes",
			description:
				"Read the contents of multiple notes. Each note's content is returned with its " +
				"path as a reference. Failed reads for individual notes won't stop " +
				"the entire operation. Reading too many at once may result in an error.",
			inputSchema: zodToJsonSchema(ReadNotesArgsSchema) as ToolInput,
		},
		{
			name: "obsidian_search_notes",
			description:
				"Searches for a note by its name. The search " +
				"is case-insensitive and matches partial names. " +
				"Queries can also be a valid regex. Returns paths of the notes " +
				"that match the query.",
			inputSchema: zodToJsonSchema(SearchNotesArgsSchema) as ToolInput,
		},
		{
			name: "obsidian_read_notes_dir",
			description:
				"Lists only the directory structure under the specified path. " +
				"Returns the relative paths of all directories without file contents.",
			inputSchema: zodToJsonSchema(ReadNotesDirArgsSchema) as ToolInput,
		},
		{
			name: "obsidian_write_note",
			description:
				"Creates a new note at the specified path. Before writing, " +
				"check the directory structure using obsidian_read_notes_dir. " +
				"If the target directory is unclear, the operation will be paused " +
				"and you will be prompted to specify the correct directory.",
			inputSchema: zodToJsonSchema(WriteNoteArgsSchema) as ToolInput,
		},
	];

	return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	try {
		const { name, arguments: args } = request.params;

		switch (name) {
			case "obsidian_read_notes": {
				const parsed = ReadNotesArgsSchema.safeParse(args);
				if (!parsed.success) {
					throw new Error(
						`Invalid arguments for obsidian_read_notes: ${parsed.error}`,
					);
				}
				const results = await Promise.all(
					parsed.data.paths.map(async (filePath: string) => {
						try {
							const validPath = await validatePath(
								path.join(vaultDirectories[0], filePath),
							);
							const content = await fs.readFile(validPath, "utf-8");
							return `${filePath}:\n${content}\n`;
						} catch (error) {
							const errorMessage =
								error instanceof Error ? error.message : String(error);
							return `${filePath}: Error - ${errorMessage}`;
						}
					}),
				);
				return {
					content: [{ type: "text", text: results.join("\n---\n") }],
				};
			}
			case "obsidian_search_notes": {
				const parsed = SearchNotesArgsSchema.safeParse(args);
				if (!parsed.success) {
					throw new Error(
						`Invalid arguments for obsidian_search_notes: ${parsed.error}`,
					);
				}
				const results = await searchNotes(parsed.data.query);

				const limitedResults = results.slice(0, SEARCH_LIMIT);
				return {
					content: [
						{
							type: "text",
							text:
								(limitedResults.length > 0
									? limitedResults.join("\n")
									: "No matches found") +
								(results.length > SEARCH_LIMIT
									? `\n\n... ${
											results.length - SEARCH_LIMIT
										} more results not shown.`
									: ""),
						},
					],
				};
			}
			case "obsidian_read_notes_dir": {
				const parsed = ReadNotesDirArgsSchema.safeParse(args);
				if (!parsed.success) {
					throw new Error(
						`Invalid arguments for obsidian_read_notes_dir: ${parsed.error}`,
					);
				}

				const validPath = await validatePath(
					path.join(vaultDirectories[0], parsed.data.path),
				);

				const dirs: string[] = [];

				async function listDirs(currentPath: string) {
					const entries = await fs.readdir(currentPath, {
						withFileTypes: true,
					});
					for (const entry of entries) {
						if (entry.isDirectory()) {
							const fullPath = path.join(currentPath, entry.name);
							try {
								await validatePath(fullPath);
								dirs.push(fullPath.replace(vaultDirectories[0], ""));
								await listDirs(fullPath);
							} catch (error) {
								console.error(`Error listing ${fullPath}:`, error);
							}
						}
					}
				}

				await listDirs(validPath);
				return {
					content: [{ type: "text", text: dirs.join("\n") }],
				};
			}
			case "obsidian_write_note": {
				const parsed = WriteNoteArgsSchema.safeParse(args);
				if (!parsed.success) {
					throw new Error(
						`Invalid arguments for obsidian_write_note: ${parsed.error}`,
					);
				}

				try {
					const validPath = await validatePath(
						path.join(vaultDirectories[0], parsed.data.path),
					);
					await fs.writeFile(validPath, parsed.data.content, "utf-8");
					return {
						content: [
							{
								type: "text",
								text: `Note successfully written to ${parsed.data.path}`,
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Please specify the target directory. Available directories:\n${vaultDirectories.join(
									"\n",
								)}`,
							},
						],
						isError: true,
					};
				}
			}
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Error: ${errorMessage}` }],
			isError: true,
		};
	}
});

// Start server
async function runServer() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("MCP Obsidian Server running on stdio");
	console.error("Allowed directories:", vaultDirectories);
}

runServer().catch((error) => {
	console.error("Fatal error running server:", error);
	process.exit(1);
});
