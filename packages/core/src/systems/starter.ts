/** Optional starter content for a new system ("starter" template). Plain Markdown, editable anywhere. */
export const STARTER_FILES: { path: string; content: string }[] = [
  {
    path: 'Welcome.md',
    content: `---
type: note
tags:
  - start
---

# Welcome

This is the starter note of a new knowledge system. Every document is a plain Markdown file in the system folder:
you can edit it here or in any other editor.

## Where to start

- Create a note and link it to another one with double brackets: [[How links work]].
- Connect a project folder in **Projects** — the files stay where they are, the application only reads them.
- Open the **Graph** to see how documents are linked.
- Set up a local model in **Models** to run agents without the cloud.

Step-by-step instructions are in the **Guide**.
`,
  },
  {
    path: 'How links work.md',
    content: `---
type: note
tags:
  - start
aliases:
  - Links
---

# How links work

- \`[[Title]]\` links to a document; \`[[Title|text]]\` shows different text.
- \`[[Title#Heading]]\` links to a section.
- \`#tag\` is a tag; nested tags use a slash: \`#project/architecture\`.
- Document properties go at the top of the file between \`---\` lines (YAML).

Incoming links are shown in the panel next to the editor. Back to the start: [[Welcome]].
`,
  },
];
