# SkyBridge - Complete Feature Documentation

## Table of Contents
1. Overview
2. System Architecture
3. Authentication System
4. API Routes and Endpoints
5. WebDAV Support
6. Token-Based Access
7. File Operations
8. Frontend Features
9. Advanced Configuration
10. Deployment Features
11. Security Notes
12. Troubleshooting

---

## Overview

SkyBridge is a serverless OneDrive index and WebDAV engine built on Cloudflare Workers. It provides a complete web interface and WebDAV server for accessing OneDrive files with advanced authentication, caching, and proxy capabilities.

Key capabilities:
- Browse OneDrive files with a modern web interface
- Dual-layer password protection (global + folder-specific)
- WebDAV server for desktop file access
- Token-based authorization system
- File upload support (chunked uploads for large files)
- Intelligent caching system
- File preview (markdown, images, videos, PDFs, Office files)

---

## System Architecture

Backend stack:
- Platform: Cloudflare Workers
- Language: TypeScript
- Storage: Cloudflare KV for tokens and cache
- Storage: OneDrive via Microsoft Graph API

Request flow:
User Request -> Cloudflare Worker -> Cache Check -> Auth -> OneDrive API -> Response

---

## Authentication System

SkyBridge supports four authentication methods. The priority order is:
1) Token-based access
2) Global password (site-wide when REQUIRE_AUTH is enabled)
3) Folder password (.password)
4) Public access (if no auth required)

Global and folder passwords stack: when both apply, the site password is asked
first and the folder password second (the browser keeps the site password for
the tab session, so it is only asked once per session).

### 1) Global Password (Site-Wide)

Configuration:
PROTECTED.REQUIRE_AUTH = true
PROTECTED.GLOBAL_PASSWORD = "your_global_password"

Behavior:
- Required for listing and uploading on every path (not only the root),
  so deep links such as /sb/?path=/Some/Folder cannot bypass it
- Sent by the frontend as `globalPasswd` in the POST body, kept for the
  browser session (sessionStorage) after it is verified once
- Direct file downloads are intentionally public so raw URLs keep working
  in video players and download managers

### 2) Folder-Specific Passwords (.password)

Configuration:
PROTECTED.FOLDER_LOCK_ENABLE = true
PROTECTED.PASSWD_FILENAME = ".password"

How to use:
1. Open /sb/token.html and select "Hash (Password)"
2. Enter your password and click Calculate
3. Copy the SHA-256 hash result
4. Create a file named .password in the target folder
5. Paste the hash into the .password file

Rules:
- A folder's .password protects the folder listing
- Subfolders inherit the password of the nearest ancestor with a .password
- A subfolder can override the inherited password with its own .password
- The folder password is separate from the global password; when both apply,
  both are required

### 3) WebDAV Authentication

Set credentials using Wrangler secrets:
npx wrangler secret put USERNAME
npx wrangler secret put PASSWORD

Access:
- Windows: Map network drive to https://your-worker.workers.dev
- macOS: Finder -> Connect to Server -> https://your-worker.workers.dev
- Linux: davfs2 or any WebDAV client

### 4) Token-Based Authorization

Tokens provide time-limited, scope-restricted access without passwords.

Token parameters:
- token: HMAC-SHA256 signature
- ts: scopes (download,list,upload,refresh,children,recursive)
- te: expiration timestamp (unix seconds)
- tb: base path for recursive access

Token generation formula:
token = HMAC_SHA256("path,scopes,expires", secret)

Example:
/Reports/file.pdf?token=abc123&ts=download&te=1735660800

---

## API Routes and Endpoints

### GET Routes

GET /sb
Purpose: Web UI for browsing and previewing files.

GET /deploysb
Purpose: OAuth authorization setup UI for initial deployment.

GET /path/to/file
Purpose: Download a file (supports query format conversion).
Optional query params:
- file: explicit file path
- format: convert file to pdf/html/jpg/glb
- token: token-based access

GET /{PROXY_KEYWORD}/path/to/file
Purpose: Proxied file download through worker.
Requires PROTECTED.PROXY_KEYWORD to be set.

### POST Routes

POST /
Purpose: List directory contents.
Request body:
{
  "path": "/Documents",
  "passwd": "optional_password",
  "skipToken": "pagination_token",
  "orderby": "name asc"
}

Response:
{
  "parent": "/Documents",
  "skipToken": "next_token",
  "orderby": "name asc",
  "files": [
    {
      "name": "file.pdf",
      "size": 1048576,
      "lastModifiedDateTime": "2024-12-01T10:30:00Z",
      "url": "https://onedrive.live.com/download/..."
    }
  ],
  "encrypted": false
}

If authentication required and missing:
{
  "parent": "/Protected",
  "files": [],
  "encrypted": true
}

If the site-wide password is missing or wrong:
{
  "parent": "/Protected",
  "files": [],
  "encrypted": true,
  "needGlobal": true
}

POST /?upload
Purpose: Request upload URLs for file uploads.
Request body:
{
  "path": "/Uploads",
  "passwd": "optional_password",
  "files": [
    { "remotePath": "/Uploads/file.pdf", "fileSize": 2048576 }
  ]
}

Response:
{
  "files": [
    {
      "remotePath": "/Uploads/file.pdf",
      "fileSize": 2048576,
      "uploadUrl": "https://graph.microsoft.com/upload/session/..."
    }
  ]
}

POST /deployreturn
Purpose: OAuth callback handler used by /deploysb (legacy /deployfodi still works).

---

## WebDAV Support

WebDAV (Web Distributed Authoring and Versioning) lets you mount your OneDrive as a network drive and use it like a normal folder from your OS. SkyBridge exposes a WebDAV endpoint on the same worker domain.

### What You Can Do with WebDAV
- Browse folders like a local drive
- Drag and drop files to upload
- Rename, move, copy, and delete files
- Use native apps (Office, media players) directly on files

### Setup Requirements
1) Set WebDAV credentials in Cloudflare Worker secrets:
  - npx wrangler secret put USERNAME
  - npx wrangler secret put PASSWORD

2) Deploy the worker and note your base URL:
  - Example: https://your-worker.workers.dev

### How to Connect (Windows)
1) Open File Explorer
2) Right-click "This PC" -> "Map network drive"
3) Choose a drive letter
4) Folder: https://your-worker.workers.dev
5) Check "Connect using different credentials"
6) Enter USERNAME and PASSWORD

Note: If Windows fails to connect, try adding the site to "Trusted Sites" in Internet Options and disable "Automatically detect settings" in LAN settings.

### How to Connect (macOS)
1) Finder -> Go -> Connect to Server
2) Enter: https://your-worker.workers.dev
3) Select "Registered User"
4) Enter USERNAME and PASSWORD
5) Click Connect

### How to Connect (Linux)
Option A: File manager (Nautilus/Dolphin)
- Connect to Server -> WebDAV -> https://your-worker.workers.dev

Option B: davfs2 mount
1) Install davfs2
2) sudo mount -t davfs https://your-worker.workers.dev /mnt/onedrive

### Authentication
WebDAV uses HTTP Basic Auth over HTTPS. The credentials are the USERNAME and PASSWORD secrets configured in Cloudflare.

### Supported Methods
- PROPFIND: list files
- GET: download file
- PUT: upload file (supports chunked upload)
- HEAD: file metadata
- COPY: copy file or folder
- MOVE: move or rename
- DELETE: delete file or folder
- MKCOL: create folder
- OPTIONS: list supported methods

### Example WebDAV Requests

List directory (Depth 1):
PROPFIND /Documents
Authorization: Basic base64(username:password)
Depth: 1

Upload file:
PUT /Documents/report.pdf
Authorization: Basic base64(username:password)
Content-Type: application/pdf

Move file:
MOVE /Documents/old.txt
Destination: /Documents/new.txt
Authorization: Basic base64(username:password)

### Notes and Limitations
- No WebDAV locking (LOCK/UNLOCK not supported)
- No PROPPATCH support
- Uploads larger than 4MB are chunked automatically
- Your Cloudflare plan may limit file sizes (100MB free, higher on paid plans)
- If PROXY_KEYWORD is set and you use a subdomain containing that keyword, GETs can be cached

### Common Problems
- Unauthorized (401): Wrong USERNAME or PASSWORD or secrets not set
- Slow listing: Enable caching (CACHE_TTLMAP) or use a PROXY_KEYWORD domain
- Files not updating: Cache may be active, use refresh token scope or lower TTL

### Best Practices
- Use WebDAV for bulk uploads or desktop workflows
- Use the web UI for previews and quick sharing
- Keep WebDAV credentials separate from global folder passwords

---

## Token-Based Access

Token scopes:
- download: download files
- list: list directory
- upload: upload files
- refresh: bypass cache
- children: access direct children
- recursive: access all subpaths

Example use cases:
1) Read-only share:
/Public?token=...&ts=download,list,recursive

2) Temporary upload:
POST /?upload with token and ts=upload&te=...

3) Time-limited document:
/Reports/2024.pdf?token=...&ts=download&te=...

---

## File Operations

### Download
GET /path/to/file
If PROXY_KEYWORD is used, the worker proxies content through Cloudflare.

### Format Conversion
Supported conversions using OneDrive:
- Office documents to pdf or html
- Images to jpg (with optional resizing)
- 3D models to glb

Example:
/slides.pptx?format=pdf

### Upload
Small files (< 4MB): single PUT to uploadUrl
Large files (>= 4MB): chunked upload session

Upload requirements:
- Authorization required
- .upload file must exist in target directory

---

## Frontend Features

Web UI features:
- Breadcrumb navigation
- Folder tree sidebar
- Sortable file list
- Lazy rendering (batch rendering for large folders)
- File previews (markdown, images, videos, PDFs, Office)
- Syntax highlighting for code blocks
- Theme toggle (light/dark)

Markdown rendering:
- GitHub-flavored markdown
- Optional KaTeX rendering
- Highlight.js code blocks

---

## Advanced Configuration

Configuration lives in `wrangler.jsonc`. This repo ships `wrangler.jsonc.example` as a template: copy it to `wrangler.jsonc` and fill in real values. `wrangler.jsonc` is gitignored so live secrets (clientSecret, GLOBAL_PASSWORD, KV id) never enter the public repository.

Key configuration fields (wrangler.jsonc):
- PROTECTED.EXPOSE_PATH: limit visible root path
- PROTECTED.REQUIRE_AUTH: enable global password
- PROTECTED.GLOBAL_PASSWORD: root password
- PROTECTED.FOLDER_LOCK_ENABLE: enable .password folders
- PROTECTED.PASSWD_FILENAME: filename for folder passwords
- PROTECTED.PROXY_KEYWORD: enable proxy mode
- CACHE_TTLMAP.GET/POST: cache TTLs in seconds

EXPOSE_PATH example:
EXPOSE_PATH = "/Public"
Root lists /Public in OneDrive.

Caching example:
CACHE_TTLMAP.GET = 3600 (1 hour)
CACHE_TTLMAP.POST = 600 (10 minutes)

---

## Deployment Features

Initial deployment:
1. Deploy worker
2. Visit /deploysb
3. Authorize via Microsoft OAuth
4. Paste redirect URL into form
5. Token stored in KV
6. Redirect to /sb

Token refresh:
- Scheduled cron runs monthly
- Manual re-auth via /deploysb

---

## Security Notes

- Global password is stored as a worker variable (plain text)
- Folder passwords are stored as SHA-256 hashes in .password files
- WebDAV credentials are stored as secrets via Wrangler
- Token secret uses the PASSWORD environment variable
- Always use HTTPS (Cloudflare provides TLS)

---

## Troubleshooting

Access Denied:
- Check if .password exists in target folder
- Confirm correct password
- Root access requires GLOBAL_PASSWORD if REQUIRE_AUTH is true

Token request failed:
- Re-run /deploysb
- Verify OAUTH clientId and clientSecret

WebDAV auth failures:
- Re-set USERNAME and PASSWORD secrets

Files not updating:
- Cache may be active; use refresh token scope or set cache TTL to 0

Upload failing:
- Ensure .upload file exists
- Verify plan limits and file size
