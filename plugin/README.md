# Files Direct for Claude Code

This plugin lets Claude send files and folders to a person's phone or computer, and receive files from one, without a browser on your machine. The person on the other side opens a link, or types a nine-digit code, in any web browser. There is no account on either side.

## What it adds

- A local MCP server with six tools: `send_files`, `receive_files`, `ask_for_files`, `transfer_status`, `cancel_transfer` and `close_room`. Each tool has a title and says whether it only reads or also writes.
- A skill, `files-direct`, that tells Claude when to use Files Direct, how to run the command-line program when it has a shell, how to read its JSON output, and what to tell you.

## What it runs, sends and fetches

- **Runs.** Claude Code starts `npx -y files-direct@0.2.0 mcp`, a pinned version of the `files-direct` package. The first start downloads that package and its two dependencies (the MCP SDK and a native connection library) from the public npm registry.
- **Reads and writes.** Only the folder Claude Code was opened in. To allow another folder, add `--allow <folder>` to the arguments under `mcpServers` in `.claude-plugin/plugin.json`. Folders that hold keys or passwords, such as `~/.ssh`, are never sent, and a link that leads out of an allowed folder is not followed.
- **Asks.** When you tell Claude to get a file from someone ("ask Sam for the signed lease"), the server opens a room that asks, and gives Claude a link and a nine-digit code to pass to that person. They see that they are being asked, by what kind of device, and the short note Claude wrote, then choose the files. They come straight to a folder you allowed, checked like any transfer, and nothing is replaced. The note goes to their device only, never to the Files Direct servers.
- **Sends.** When you ask Claude to send something, the server opens a room on the Files Direct site and gives Claude a link and a nine-digit code to pass to the person. The files go straight from your machine to their device. When the two networks will not connect directly, the encrypted files pass through the Files Direct servers on the way. They are not stored there and cannot be opened there.
- **Asks the site.** The server asks the site for its connection settings, and asks a public address service run by Cloudflare to find a direct route, as the web page does.
- **Keeps.** Nothing about you. There is no account and no usage reporting. The site keeps a short, wordless record of each room for 30 days: that a command-line program was one side, which system it ran on, and how the two devices connected. Never file names, links, codes or addresses.

## Install

Once the plugin is listed in Claude's directory, install it from there. Until then, point Claude Code at this folder:

```
claude --plugin-dir <this folder>
```

It needs Node.js 22 or newer on your machine.

## Licence

MIT. See `LICENSE`.
