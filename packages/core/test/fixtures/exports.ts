// Small exports in the same shape ChatGPT and Claude produce. Used by the parser
// tests and by the end-to-end test that imports them through the browser.

import { strToU8, zipSync } from "fflate";

export function chatGptConversations(marker = "") {
  return [
    {
      id: "conv-1",
      conversation_id: "conv-1",
      title: "Planning a garden",
      create_time: 1735732800.5,
      update_time: 1735736400.25,
      current_node: "n4b",
      mapping: {
        root: { id: "root", message: null, parent: null, children: ["n0"] },
        n0: {
          id: "n0",
          parent: "root",
          children: ["n1"],
          message: { author: { role: "system" }, content: { content_type: "text", parts: [""] }, metadata: { is_visually_hidden_from_conversation: true } },
        },
        n1: {
          id: "n1",
          parent: "n0",
          children: ["n2"],
          message: { author: { role: "user" }, create_time: 1735732801, content: { content_type: "text", parts: [`Which vegetables grow in shade? ${marker}`] } },
        },
        n2: {
          id: "n2",
          parent: "n1",
          children: ["n3"],
          message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Lettuce, spinach and kale do well."] } },
        },
        n3: {
          id: "n3",
          parent: "n2",
          children: ["n4a", "n4b"],
          message: { author: { role: "user" }, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer" }, "Here is my plot."] } },
        },
        n4a: {
          id: "n4a",
          parent: "n3",
          children: [],
          message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["An abandoned branch."] } },
        },
        n4b: {
          id: "n4b",
          parent: "n3",
          children: [],
          message: { author: { role: "assistant" }, content: { content_type: "code", text: "plant('kale')" } },
        },
      },
    },
    {
      id: "conv-2",
      title: null,
      create_time: 1735819200,
      mapping: {
        a: { id: "a", parent: null, children: ["b"], message: { author: { role: "user" }, create_time: 1, content: { content_type: "text", parts: ["Hello again"] } } },
        b: { id: "b", parent: "a", children: [], message: { author: { role: "tool" }, create_time: 2, content: { content_type: "text", parts: ["tool output"] } } },
      },
    },
    { id: "conv-3", title: "Empty", mapping: {} },
  ];
}

export function claudeConversations(marker = "") {
  return [
    {
      uuid: "c-1",
      name: "Learning to sail",
      created_at: "2026-02-01T10:00:00.000Z",
      updated_at: "2026-02-01T11:00:00.000Z",
      chat_messages: [
        { sender: "human", text: `What knots should I learn first? ${marker}`, content: [], attachments: [{ file_name: "boat.pdf" }] },
        { sender: "assistant", text: "fallback", content: [{ type: "thinking", text: "hidden" }, { type: "text", text: "Start with the bowline." }] },
      ],
    },
    { uuid: "c-2", name: "", created_at: "2026-02-02T10:00:00.000Z", chat_messages: [] },
  ];
}

export function claudeProjects() {
  return [
    {
      uuid: "p-1",
      name: "Novel draft",
      description: "A story about a lighthouse keeper.",
      prompt_template: "Write in a calm voice.",
      created_at: "2026-03-01T09:00:00.000Z",
      docs: [{ uuid: "d-1", filename: "chapter-1.md", content: "The lamp was lit at dusk.", created_at: "2026-03-02T09:00:00.000Z" }],
    },
  ];
}

export function claudeMemories() {
  return [{ conversations_memory: "Prefers short answers.", project_memories: { "p-1": "Keeps the tone calm." } }];
}

export function chatGptZip(marker = ""): Uint8Array {
  return zipSync({
    "conversations.json": strToU8(JSON.stringify(chatGptConversations(marker))),
    "user.json": strToU8(JSON.stringify({ id: "user-x" })),
    "chat.html": strToU8("<html></html>"),
  });
}

export function claudeZip(marker = ""): Uint8Array {
  return zipSync({
    "data-2026/conversations.json": strToU8(JSON.stringify(claudeConversations(marker))),
    "data-2026/projects.json": strToU8(JSON.stringify(claudeProjects())),
    "data-2026/memories.json": strToU8(JSON.stringify(claudeMemories())),
    "data-2026/users.json": strToU8(JSON.stringify([{ uuid: "u" }])),
  });
}
