# SkyBridge

SkyBridge - Serverless OneDrive Index and WebDAV Engine

## Preview

- Open your worker domain at `/sb` after deployment

## Features

- Specify display path
- Encrypt specific folders
- Free deployment without server
- Basic preview for text, images, audio/video, and Office files
- Generate resumable Jellyfin `.strm` libraries from OneDrive folders

## Limitations

- Simple functionality with basic interface
- Does not support IE and UWP version of EDGE browser

## Deployment

### One-Click Deployment

> [!CAUTION]
> Supported only for personal accounts; use alternatives for other types account. Creating your own app is recommended.

1. [Import the project to your private Github repository](https://docs.github.com/en/migrations/importing-source-code/using-github-importer/importing-a-repository-with-github-importer#importing-a-repository-with-github-importer)
2. Edit `wrangler.jsonc` and commit changes
3. [Import your Github repository from Cloudflare console](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)
4. Access your domain with `/deploysb` to complete OneDrive authorization

> [!NOTE]
> You need to get the [kv_namespaces id](https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces) and fill it in `wrangler.jsonc`

<details>
    <summary>Or</summary>

### Command Push

```sh
git clone <your-fork-url>
cd SkyBridge
# edit wrangler.jsonc, then
bun install
bun run deploy
# webdav config
bunx wrangler secret put USERNAME
bunx wrangler secret put PASSWORD
```

</details>

<details>
    <summary>Other Matters</summary>

## Configuration

### Encryption

- Method 1: Fill in the SHA256 hash value in the custom password file
- Method 2: Value of environment variable `PASSWORD`

### WEBDAV

- Account password settings: Set **secrets** in **Variables and Secrets**, variable names are `USERNAME` and `PASSWORD`
- File upload limits: FreePlan 100MB, BusinessPlan 200MB, EnterprisePlan 500MB

### Preview

- pdf: If you need to use local PDF preview, go to [PDF.js](https://mozilla.github.io/pdf.js/) to download the file, extract and name it `pdfjs`, comment out the `fileOrigin !== viewerOrigin` condition in `viewer.mjs`, and modify `//mozilla.github.io/pdf.js/web/viewer.html?file=`
- markdown: On the webpage, you can choose whether to enable github alert and katex format in `Optional Markdown extensions`

### Download

- Access via `PROXY_KEYWORD` to let worker proxy
- Access `https://example.com/a.html?format=` to add the target conversion format, [supported conversion formats](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/api/driveitem_get_content_format?view=odsp-graph-online#format-options)

### Parameters

1. `path`: Frontend (all backend unless otherwise specified), frontend starting directory
2. `token`: Access token, format is HMAC-SHA256 of `path,ts,te`
3. `ts`: Optional token parameter, token permissions, `download,refresh,list,upload,children,recursive`, defaults to download if not filled
4. `te`: Optional token parameter, token expiration date, format is unix timestamp (in seconds), defaults to permanent if not filled
5. `tb`: Optional token parameter, token starting directory, used with `recursive` permission
6. `format`: Convert source file to format when downloading, [supported formats](#download)
7. `file`: Download file address, `/a/a.txt`

> Example: To download /Abc/a.txt, password is 123456, path /Abc, expiration time 1735660800 (2025-01-01 00:00:00)
> `/Abc,download,1735660800` via HMAC-SHA256 gets `https://example.com/Abc/a.txt?token=b5b0b5e80533c614dc78b968685d3467f93e63a6e596cb12ffce6ff38007e034&te=1735660800&format=pdf`

## Development

```sh
bun install
# edit wrangler.jsonc, then
bun run type
bun run dev
```

## Jellyfin STRM library

Place a `.jellyfinconfig` file in a dedicated OneDrive folder, browse that folder in SkyBridge, and use
**Refresh Jellyfin Streams** to mirror Movies and Series as `.strm` files. See
[JELLYFIN.md](./JELLYFIN.md) for configuration, rclone, MediaWarp, and direct-play verification.

</details>
