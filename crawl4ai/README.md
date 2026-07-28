# Crawl4AI (optional)

Turns a URL into clean markdown. Eva uses it only when a search result
needs to be read rather than just cited.

## Enabling

The installer asks:

```
Install Crawl4AI for reading and cleaning web pages? [y/N]
```

Answering yes appends `crawl4ai` to `COMPOSE_PROFILES` in `.env`. To
change your mind later:

```bash
# enable
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=crawl4ai/' .env
make start

# disable
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=/' .env
docker compose --env-file versions.env --env-file .env stop crawl4ai
```

## Cost

Crawl4AI runs a headless Chromium. On the reference server (4 vCPU / 8 GB)
budget roughly 1–1.5 GB of RAM while crawling, which is why `max_pages` is
capped at 4 and `text_mode` is on. It is off by default for exactly this
reason.

## Use from n8n

`03-eva-web-search.json` calls it only when the caller passes
`fetch_pages: true`:

```
POST http://crawl4ai:11235/md
Authorization: Bearer $CRAWL4AI_API_TOKEN
{"url": "…", "f": "fit"}
```

The node is set to `continueRegularOutput`, so if the profile is not
installed the search still returns its results without page bodies.
