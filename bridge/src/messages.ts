import { Actions, Button, Card, CardText, cardChildToFallbackText, type CardChild, type CardElement } from "chat";

export function renderCard(card: CardElement): string {
  function render(child: CardChild): string {
    if (child.type === "section") return child.children.map(render).join("\n");
    if (child.type === "actions") return child.children.map((action) => {
      if (action.type === "button" && !action.disabled && action.value?.startsWith("/")) return action.label + "：" + action.value;
      if (action.type === "link-button") return action.label + "：" + action.url;
      return "";
    }).filter(Boolean).join("\n");
    return cardChildToFallbackText(child) ?? "";
  }
  return [card.title, card.subtitle, ...card.children.map(render)].filter(Boolean).join("\n");
}

export function taskNotice(id: string, text: string, canContinue: boolean): string {
  return renderCard(Card({ title: id, children: [CardText(text), ...(canContinue ? [Actions([
    Button({ id: "continue", label: "继续", value: "/continue " + id }),
    Button({ id: "cancel", label: "取消", value: "/cancel " + id }),
  ])] : [])] }));
}

export function splitReply(text: string): string[] {
  const parts: string[] = [];
  let current = "", size = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    const bytes = Buffer.byteLength(segment);
    if (bytes > 1800) throw new Error("A single grapheme exceeds the reply limit.");
    if (size + bytes > 1800) { parts.push(current); current = ""; size = 0; }
    current += segment; size += bytes;
  }
  if (current) parts.push(current);
  return parts.length ? parts : ["（空回复）"];
}

// iMessage shows text as is, so an agent's Markdown would arrive as raw ** and ``` marks.
export function plainText(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) { out.push(line); continue; }
    out.push(line
      .replace(/^(\s{0,3})#{1,6}\s+/, "$1")
      .replace(/!\[([^\]]*)\]\([^)\s]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => label === url ? url : label + "（" + url + "）")
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/`([^`\n]+)`/g, "$1"));
  }
  return out.join("\n");
}
