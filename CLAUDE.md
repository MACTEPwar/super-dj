# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository is currently empty — no code has been written yet. This file captures the
project plan agreed on during design brainstorming, so it can guide the initial implementation.
**Update this file once real code, build tooling, and tests exist** — replace the "Planned
architecture" section below with what's actually there, and add real commands under
"Development commands".

## Project overview

An autonomous YouTube streamer: a service that runs in Docker on Linux and streams a local
playlist of songs to YouTube Live continuously, controlled externally via a REST API
(start/stop for the MVP; live control — skip, insert tracks — is a planned follow-up).

## Planned architecture (MVP)

- **Stack:** Node.js / TypeScript.
- **Control plane:** a REST API service (e.g. `POST /stream/start`, `POST /stream/stop`) that
  manages the streaming process's lifecycle.
- **Streaming pipeline:** a single long-lived `ffmpeg` process per session, using the concat
  demuxer to play local audio files back-to-back over one continuous RTMP connection to
  YouTube, paired with a simple static-image/looping video track. One ffmpeg process per
  session is deliberate — restarting ffmpeg between songs would drop/reconnect the RTMP
  connection to YouTube.
- **Playlist source:** local audio files (mounted into the container), referenced by a
  generated playlist manifest passed to ffmpeg's concat demuxer.
- **Deployment:** Docker container(s) on Linux; the YouTube RTMP URL and stream key are
  supplied as secrets/env vars, not committed to the repo.

## Planned evolution (post-MVP)

Live control of an in-progress stream (skip track, insert a track, reorder) requires replacing
the concat-demuxer pipeline with a named-pipe (FIFO) architecture: the Node service writes
audio/video segments into a FIFO that a persistent ffmpeg process reads from, so the RTMP
connection never needs to restart when the playlist changes mid-stream. The REST API layer and
Docker packaging are expected to carry over unchanged; only the internal "player" component
changes.

## Tooling

This project is being developed with help from the [wshobson/agents](https://github.com/wshobson/agents)
Claude Code plugin marketplace. No repo-specific plugin has been chosen/pinned yet.

## Development commands

Not yet established — no `package.json`, build, lint, or test setup exists yet.
