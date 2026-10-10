import { DOMParser, parseHTML } from "linkedom";

export type ParsedDocument = ReturnType<typeof parseHTML>["document"];

/** Parse HTML into a linkedom `Document`. */
export function parseDocument(html: string): ParsedDocument {
  return parseHTML(html).document;
}

/**
 * Parse XML, such as an RSS or Atom feed. XML parsing keeps the text of
 * non-void elements like `<link>`, which HTML parsing discards.
 */
export function parseXmlDocument(xml: string): ParsedDocument {
  return new DOMParser().parseFromString(xml, "text/xml") as ParsedDocument;
}
