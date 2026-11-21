// The panel that floats over the art of the first screen: the read log of a
// vault, in the look of the vault. It is an example and says so; it shows no
// times and no counts, because nothing in it is read from a real vault.

import { ChatGptIcon, ClaudeIcon, CursorIcon, SealIcon } from "@/components/icons";

const rows = [
  { icon: ClaudeIcon, text: "Claude read Work", state: "Allowed", on: true },
  { icon: CursorIcon, text: "Cursor read Projects", state: "Allowed", on: true },
  { icon: ChatGptIcon, text: "ChatGPT asked to read Health", state: "Held", on: false },
  { icon: SealIcon, text: "The hour is sealed", state: "Verified", on: true },
];

export function HeroPanel() {
  return (
    <figure className="hero-panel" aria-label="Example of the read log in a vault">
      <div className="hero-panel-head">
        <span>Read log</span>
        <span>Your vault</span>
      </div>
      <ul className="hero-panel-rows">
        {rows.map(({ icon: Icon, text, state, on }) => (
          <li key={text} className="hero-panel-row" data-on={on}>
            <Icon />
            <span className="hero-panel-text">{text}</span>
            <span className="hero-panel-state">{state}</span>
          </li>
        ))}
      </ul>
      <figcaption className="hero-panel-note">An example of the read log in your vault.</figcaption>
    </figure>
  );
}
