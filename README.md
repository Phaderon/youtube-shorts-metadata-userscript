# YouTube Shorts Metadata

Small companion userscript for YouTube that adds missing metadata back onto Shorts cards:

- duration badge on the thumbnail
- upload date line under the card metadata

It is intended to complement browser extensions such as Tweaks for YouTube without replacing them.

Install URL:

```text
https://raw.githubusercontent.com/Phaderon/youtube-shorts-metadata-userscript/main/youtube-shorts-metadata.user.js
```

## How It Works

YouTube Shorts grid cards often only include title, views, thumbnail, and video ID in the page data. This script fetches the same-origin watch page for visible Shorts, parses YouTube's own `lengthSeconds`, `publishDate`, and `uploadDate` metadata, then caches results in YouTube localStorage.
