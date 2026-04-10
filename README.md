    ██╗     ███████╗███████╗████████╗███████╗ ██████╗ ██╗  ██╗
    ██║     ██╔════╝██╔════╝╚══██╔══╝██╔════╝██╔═══██╗╚██╗██╔╝
    ██║     █████╗  █████╗     ██║   █████╗  ██║   ██║ ╚███╔╝
    ██║     ██╔══╝  ██╔══╝     ██║   ██╔══╝  ██║   ██║ ██╔██╗
    ███████╗███████╗███████╗   ██║   ██║     ╚██████╔╝██╔╝ ██╗
    ╚══════╝╚══════╝╚══════╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝  ╚═╝
# 🦊

A Chrome extension that provides Socratic DSA coaching in a side panel while you solve LeetCode and NeetCode problems. Instead of giving you answers, it guides you toward them through questions, then logs the session to Notion for spaced repetition review.

## Features

- **Socratic coaching** — Claude asks questions and gives nudges rather than spoiling solutions
- **Automatic problem detection** — reads the problem title, difficulty, and tags from the active LeetCode or NeetCode page
- **Manual entry fallback** — if scraping fails, enter the problem title and difficulty by hand
- **Voice input** — speak your thoughts instead of typing (uses Web Speech API)
- **Session summary** — on session end, Claude generates a personalized 2-sentence retrospective: what you did well or struggled with in this specific session, and one concrete thing to focus on next time
- **Performance score** — 1–5 rating calibrated to your actual hint count and how independently you reached the solution
- **Notion logging** — posts a structured record to your Notion database with problem metadata, detected patterns, score, and notes
- **Spaced repetition intervals** — configurable review intervals per performance score

## Setup

### 1. Load the extension

1. Clone or download this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder

### 2. Add your Anthropic API key

1. Click the LeetFox icon, then open **Settings**
2. Paste your API key from [console.anthropic.com](https://console.anthropic.com) (starts with `sk-ant-`)

### 3. Set up Notion (optional)

If you want to log sessions to Notion:

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and create an integration
2. Create a Notion database with these exact columns:

   | Column | Type |
   |--------|------|
   | Problem | Title |
   | LC # | Number |
   | Type | Select |
   | Pattern | Multi-select |
   | Difficulty | Select |
   | Last Result | Select |
   | Last Done | Date |
   | Interval (days) | Number |
   | Times Reviewed | Number |
   | Notes | Rich text |

3. Share the database with your integration (open the database → ··· → Connections)
4. Copy the database ID from the URL: `notion.so/username/{DATABASE_ID}?v=…`
5. In LeetFox Settings, paste your integration token (`secret_…`) and database ID

### 4. Enable voice input (optional)

In Settings, click **Enable Microphone** and grant the permission when prompted. Chrome requires this to be done from a settings page rather than the side panel.

## How it works

1. Open a problem on [leetcode.com/problems/](https://leetcode.com/problems/) or [neetcode.io/problems/](https://neetcode.io/problems/)
2. Open the LeetFox side panel (click the extension icon)
3. Click **Start Session** — Claude opens with a Socratic prompt tailored to the problem
4. Work through the problem, asking for hints or talking through your approach
5. When done, click **End Session**
6. Review your session stats, detected patterns, summary, and score
7. Click **Log to Notion** to save the record, or **Copy Session Data** for JSON export

## Configuring spaced repetition intervals

In Settings, set the number of days before you should review the problem again based on how it went:

- **Clean solve** — default 14 days
- **Hints needed** — default 7 days
- **Failed** — default 3 days

These are written to the `Interval (days)` field in Notion.

## Privacy & disclaimer

- Your API key and Notion credentials are stored locally in `chrome.storage.local` and never sent anywhere except the respective APIs
- Problem content and your conversation are sent to Anthropic's API to generate responses
- This extension reads content from LeetCode and NeetCode pages. Use it in accordance with those sites' terms of service
- This project is not affiliated with LeetCode, NeetCode, Anthropic, or Notion

## Tech

- Vanilla JS Chrome Extension (Manifest V3)
- Anthropic Messages API with streaming (`claude-sonnet-4-6`)
- Notion API via background service worker (to work around CORS)
- Web Speech API for voice input
- No build step, no dependencies
