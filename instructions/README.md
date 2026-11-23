# Installing the instructions (one-time, per platform)

`instructions.txt` is **the rules the AI needs to use your tools**: the call format, the JSON rules,
how to read a result, and how to ask for the tool list. It is generated from the extension itself
(`npm run instructions` — never edit it by hand), so the text and the parser can never disagree.

The extension writes **nothing** into your chats. Install this text **once** where the platform keeps
instructions for the model — a Project, a custom GPT, or a Gemini Skill — and from then on:

- in a ChatGPT/Claude **Project** the rules travel with every message; in a Gemini **Skill** they apply
  to the chat once you add it — type `/` and pick the skill (Gemini also applies it on its own when it
  sees the moment fit);
- the AI asks for the tool list itself with `{"mcp_call":{"server":"bridge","name":"list_tools"}}`,
  and the answer arrives as a normal tool result;
- a message may carry one or more independent calls; dependent calls go in a later message, and the
  results come back in call order, one block per call;
- a wrong server or tool name is answered with the valid list, so the AI recovers on its own.

## Where to put it

| Platform | Where | Notes |
|---|---|---|
| **Claude** | A **Project** → its *Instructions* | Paste the text. Chats must be started inside that Project. |
| **ChatGPT** | A **Project** → its instructions (or upload `instructions.txt` as a project file), or a **custom GPT** with the text in its instructions | The *Settings → Personalization → Custom instructions* boxes are too small (≈1500 characters) — use a Project or a GPT. |
| **Gemini** | A **Skill** → its *instructions*: create it once with **Customize Skills → Create → Create manually**, paste the text into the *instructions* and save | Use it in any chat by typing `/` and picking the skill (Gemini also applies it on its own when relevant). |
| **DeepSeek** | — | It has no place for instructions, so the AI there cannot be told about the tools. |

The welcome page shows this text with a **Copy** button, so you can paste it without opening the
file by hand.

## Checking that it works

Open a chat where the rules are active — a chat started **inside** the ChatGPT/Claude Project, or any
Gemini chat with the skill invoked (`/`) — and ask something that needs the machine, for example
*"What time is it on this computer? Use your tools."* The AI should first emit a `list_tools` call and
then call a real tool. If it instead answers *"I don't have access"*, the instructions are not active
in that chat — the panel also warns you: *the AI says it has no access: check that the Project/Skill
with the LongArm instructions is installed and active in this chat*.

Two more things worth knowing:

- **The name `bridge` is reserved** for the tool-list call. A real MCP server registered under that
  name takes priority and the tool-list call stops working.
- **Batches are for independent calls.** Asking for two reads in one message is fine; a call that needs
  the previous answer must wait for its result. The extension runs a batch in order and answers every
  call, even when one of them is refused or fails.
- **Clean chat is only about display.** With *Keep the chat clean* on (Settings → *The chat*), the
  tool results, the tool list and the notices are kept out of sight, and so is the AI's `mcp_call`
  message — the AI still receives all of it. Turning it off puts everything back on screen; it has
  nothing to do with installing this text.
