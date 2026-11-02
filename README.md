# Claude Browser Bridge

Lets Claude Desktop control your real Chrome, including **file uploads**.

```
Claude Desktop ──stdio(MCP)──> server/index.js ──ws://127.0.0.1:18765──> Chrome extension ──CDP──> tabs
```

## Setup

1. **Load the extension:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension` folder.
2. **Register the server:** add this to `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config).
   On this PC the file is `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude_desktop_config.json`; a backup of the original is next to it as `.bak-before-browser-bridge`.
   ```json
   { "mcpServers": { "browser-bridge": {
       "command": "C:\\Program Files\\nodejs\\node.exe",
       "args": ["C:\\Users\\maung\\claude-chrome\\server\\index.js"] } } }
   ```
3. **Restart Claude Desktop fully** (quit it from the system tray). The extension badge turns green **ON** once it's connected.

## Tools

`list_tabs`, `new_tab`, `switch_tab`, `close_tab`, `navigate`, `screenshot`, `read_page`, `get_text`,
`click`, `type`, `press_key`, `scroll`, `select_option`, `upload_file`, `evaluate`, `wait_for`.

`upload_file` takes absolute local paths. Its `ref` can be:
- a file input that `read_page` lists (hidden ones are included), or
- the button or drop zone that normally opens the file picker. The picker is intercepted and filled automatically, so no dialog appears.

Example prompt: *"Open the job page in Chrome and upload C:\Users\maung\Documents\resume.pdf as my CV."*

## Notes

- Chrome shows a bar saying the extension "started debugging this browser" while Claude is controlling a tab. That's expected. Clicking Cancel detaches it, and it reattaches on the next command.
- `chrome://` pages and the Chrome Web Store can't be automated (Chrome's restriction).
- The WebSocket only listens on 127.0.0.1 and only accepts `chrome-extension://` origins, so websites can't connect to it.
- To change the port, set `BROWSER_BRIDGE_PORT` in the server's `env` and edit `PORT` in `extension/background.js`.
