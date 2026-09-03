# Jellyfin STRM Library

SkyBridge can generate a lightweight Jellyfin library in OneDrive. Jellyfin scans small `.strm`
files while compatible clients follow SkyBridge's redirect to OneDrive for the media itself.

## OneDrive layout

Create source libraries and a separate generated library folder:

```text
/Movies/
/Series/
/Jellyfin/
  .jellyfinconfig
```

`.jellyfinconfig` must be valid JSON and its paths are relative to SkyBridge's exposed root:

```json
{
  "moviePath": "/Movies",
  "seriesPath": "/Series"
}
```

The generated outputs are always `Movies` and `Series` below the folder containing the config:

```text
/Movies/Film (2025)/Film.mkv
  -> /Jellyfin/Movies/Film (2025)/Film.strm

/Series/Show/Season 01/Episode 01.mkv
  -> /Jellyfin/Series/Show/Season 01/Episode 01.strm
```

Browse `/Jellyfin` in SkyBridge and select **Refresh Jellyfin Streams**. Refreshes run in bounded,
resumable steps. The browser can be closed and the job resumes when the same folder is opened
again. SkyBridge stores reconciliation metadata in `.jellyfinmanifest.json`.

The generated `Movies` and `Series` folders are dedicated outputs. Refresh removes stale `.strm`
files and empty folders, but preserves posters, subtitles, NFO files, and every other non-`.strm`
file. Two source videos that would produce the same `.strm` name are reported as a collision and
that destination is not changed.

Supported source extensions are `mkv`, `mp4`, `m4v`, `avi`, `mov`, `webm`, `ts`, `m2ts`, `mts`,
`mpg`, `mpeg`, `wmv`, and `flv`.

Each stream uses an Android-compatible stable URL whose 32-character media id is derived from
the normalized source path and whose filename preserves the source media extension:

```text
https://worker.example.com/jellyfin/0123456789abcdef0123456789abcdef/stream.mkv?file=%2FMovies%2FFilm.mkv
```

The `file` query parameter remains authoritative; the compatibility id is only a stable client
cache key.

> The presence of `.jellyfinconfig` authorizes refresh operations for that folder. Anyone who can
> access the index can start a refresh.

## Jellyfin host

Mount only the generated folder and keep Jellyfin's database, cache, and configuration on local
storage. One possible read-only rclone mount is:

```sh
rclone mount onedrive:Jellyfin /mnt/jellyfin-strm --read-only --vfs-cache-mode minimal
```

Add `/mnt/jellyfin-strm/Movies` and `/mnt/jellyfin-strm/Series` as separate Jellyfin libraries.

Put a pinned [MediaWarp](https://github.com/AkimioJR/MediaWarp) release in front of Jellyfin and
enable its Jellyfin HTTPStrm redirect support. Jellyfin clients must connect through MediaWarp.
Validate the exact client before relying on direct playback; MediaWarp's upstream compatibility
list does not currently promise every Jellyfin client.

For a direct-only setup, disable transcoding, remuxing, chapter-image extraction, trickplay,
image extraction, and subtitle burn-in. Upload media already supported by the target device. If a
client cannot direct play a file, playback should fail instead of falling back to VPS media traffic.

## Verification

During a playback test:

1. Confirm the `.strm` contains a stable SkyBridge `/jellyfin/{id}/stream.ext?file=` URL, not a
   temporary OneDrive URL.
2. Confirm SkyBridge responds with a redirect to OneDrive for both `GET` and `HEAD`.
3. Confirm the client connects to the OneDrive download host.
4. Check Jellyfin/MediaWarp logs and VPS network counters to ensure the video body is not proxied
   or transcoded by Jellyfin.
