import React, { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target={href.startsWith("#") ? undefined : "_blank"}
                rel="noopener noreferrer"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          // Images remain explicit links; provider output cannot trigger remote requests.
          img: ({ src, alt }) =>
            typeof src === "string" && src ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || "Open image"}
              </a>
            ) : (
              <span>{alt}</span>
            ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
