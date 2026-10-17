# Rewind

Rewind is a desktop AI agent that acts like a temporary memory and recovery layer for your computer session.

While the user is working, Rewind tracks useful session events such as opened applications, visited websites, accessed files, file changes, and timestamps. Instead of manually searching through browser history, folders, or recent files, the user can ask natural-language questions such as:

“What website did I open earlier that talked about machine learning?”
“What PDF was I reading before I opened VS Code?”
“What was I working on around 2 PM?”
“Give me the previous version of this Word file.”
Rewind can also create temporary checkpoints of selected files and workspace state. If the user makes unwanted changes, the agent can find the relevant checkpoint or file version and help restore it safely.

The goal is to make digital work easier to remember, recover, and continue without permanently recording everything the user does. Session data is stored locally or on the cloud and temporarily, then automatically deleted after a configurable amount of time unless the user chooses to keep a checkpoint.

Project Goals
Track important activity during a computer session, including apps, websites, files, and timestamps.
Let users search and ask questions about their session history using natural language.
Keep temporary versions of supported files so users can recover previous versions.
Allow users to create named checkpoints before making important changes.
Let the agent reopen relevant websites, files, and workspace resources from earlier in the session.
Keep session data local or on the cloud and automatically delete old records after a configurable retention period.
Require user confirmation before restoring or overwriting files.
Scope of Work
Build a desktop application with a small interface for starting, viewing, and ending sessions.
Record a structured session timeline instead of continuously recording the entire screen.
Track active applications, browser pages, opened files, file changes, and timestamps.
Build an AI agent using Google ADK and Gemini that can search session history and answer natural-language questions.
Create temporary file snapshots when supported files are changed or saved.
Build a recovery flow that lets users preview and restore an earlier file version.
Add manual and automatic checkpoints that save selected workspace information.
Allow Rewind to reopen supported files, websites, and project resources from a checkpoint.
Automatically clean up session data after the configured retention period.
Keep the MVP focused on recall, recovery, and checkpoints rather than full computer control or permanent screen recording.
Tech Stack
Electron, React, TypeScript, Node.js, SQLite, Google ADK, Gemini API, local file system APIs, browser activity integration, OS-level window/activity APIs, and local temporary storage.
