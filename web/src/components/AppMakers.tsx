import { ChatGptIcon, ClaudeIcon, CursorIcon, McpIcon } from "./icons";

const makers = [
  { name: "Claude", Icon: ClaudeIcon },
  { name: "ChatGPT", Icon: ChatGptIcon },
  { name: "Cursor", Icon: CursorIcon },
  { name: "Any MCP client", Icon: McpIcon },
];

/** The AI apps Sigil connects to, as a row of marks. */
export function AppMakers() {
  return (
    <ul className="app-makers" aria-label="Works with">
      {makers.map(({ name, Icon }) => (
        <li key={name} className="app-maker">
          <Icon className="app-maker-icon" />
          <span className="app-maker-name">{name}</span>
        </li>
      ))}
    </ul>
  );
}
