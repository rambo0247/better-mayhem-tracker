import type { ReactNode } from "react";

// Renders the subset of markdown that release notes actually use: bullets with
// one level of nesting, headings, bold, inline code, links and bare URLs. The
// output is built as React elements rather than HTML, so text arriving from the
// GitHub API can never inject markup.

const INLINE =
  /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)/g;

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      onClick={() => window.api.openUrl(href)}
      className="cursor-pointer text-left font-medium text-lol-gold underline-offset-2 transition-colors hover:text-lol-gold-light hover:underline"
    >
      {children}
    </button>
  );
}

// A bare URL reads as the site it points at rather than the whole address,
// which in release notes is nearly always a long GitHub link
function linkLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "github.com" ? "GitHub" : host;
  } catch {
    return url;
  }
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const [, bold, code, linkText, linkUrl, bareUrl] = match;
    if (bold !== undefined) {
      nodes.push(
        <strong key={key++} className="font-semibold text-lol-text-bright">
          {bold}
        </strong>,
      );
    } else if (code !== undefined) {
      nodes.push(
        <code key={key++} className="font-sans font-semibold text-lol-text-bright">
          {code}
        </code>,
      );
    } else if (linkUrl !== undefined) {
      nodes.push(
        <ExternalLink key={key++} href={linkUrl}>
          {linkText}
        </ExternalLink>,
      );
    } else if (bareUrl !== undefined) {
      nodes.push(
        <ExternalLink key={key++} href={bareUrl}>
          {linkLabel(bareUrl)}
        </ExternalLink>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type ListItem = { text: string; nested: boolean };
type Block =
  | { kind: "list"; items: ListItem[] }
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string };

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let list: ListItem[] | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", items: list });
    list = null;
  };

  for (const line of markdown.split("\n")) {
    const bullet = line.match(/^([ \t]*)[-*+]\s+(.*)$/);
    if (bullet) {
      flushPara();
      // Indentation of any kind counts as one nesting level; release notes have
      // never gone deeper, and flattening the rest keeps the layout predictable.
      const items = list ?? (list = []);
      items.push({ text: bullet[2], nested: bullet[1].length > 0 });
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    // Wrapped prose lines belong to one paragraph; a bullet list ends it.
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2.5">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "list") {
          return (
            <ul key={i} className="space-y-1.5">
              {block.items.map((item, j) => (
                <li key={j} className={`flex gap-2.5 ${item.nested ? "ml-5" : ""}`}>
                  {/* A small diamond for the bullet, hollow for a nested one */}
                  <span
                    aria-hidden
                    className={`mt-[7px] h-[5px] w-[5px] shrink-0 rotate-45 ${
                      item.nested ? "border border-lol-text/50" : "bg-lol-gold/70"
                    }`}
                  />
                  <span className="flex-1">{renderInline(item.text)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === "heading") {
          return (
            <p key={i} className="label pt-1 text-[13px] text-lol-text-bright">
              {renderInline(block.text)}
            </p>
          );
        }
        return <p key={i}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}
