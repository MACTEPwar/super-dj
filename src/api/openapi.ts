export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Super DJ Streamer API',
    version: '1.0.0',
    description: 'Multi-tenant control plane for continuous YouTube Live (and other RTMP) audio streams with a Now Playing video screen.',
  },
  paths: {
    '/tracks': {
      post: {
        summary: 'Upload a new track (multipart/form-data: audio, optional cover, optional name)',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['audio'],
                properties: {
                  audio: { type: 'string', format: 'binary' },
                  cover: { type: 'string', format: 'binary' },
                  name: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Track uploaded', content: { 'application/json': { schema: { $ref: '#/components/schemas/TrackSummary' } } } },
          '400': { description: 'Missing or invalid audio/cover file' },
          '401': { description: 'Not authenticated' },
        },
      },
      get: {
        summary: 'List the authenticated user\'s tracks',
        responses: {
          '200': { description: 'Track list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/TrackSummary' } } } } },
          '401': { description: 'Not authenticated' },
        },
      },
    },
    '/tracks/{id}': {
      delete: {
        summary: 'Delete a track owned by the authenticated user',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Track deleted' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your track' },
          '404': { description: 'Track not found' },
        },
      },
    },
    '/playlists': {
      post: {
        summary: 'Create a new playlist',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'Playlist created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Playlist' } } } },
          '400': { description: 'Missing or invalid name' },
          '401': { description: 'Not authenticated' },
        },
      },
      get: {
        summary: 'List the authenticated user\'s playlists',
        responses: {
          '200': { description: 'Playlist list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Playlist' } } } } },
          '401': { description: 'Not authenticated' },
        },
      },
    },
    '/playlists/{id}': {
      get: {
        summary: 'Get a playlist and its ordered tracks',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Playlist with tracks', content: { 'application/json': { schema: { $ref: '#/components/schemas/PlaylistWithTracks' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist' },
          '404': { description: 'Playlist not found' },
        },
      },
      delete: {
        summary: 'Delete a playlist owned by the authenticated user',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Playlist deleted' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist' },
          '404': { description: 'Playlist not found' },
        },
      },
    },
    '/playlists/{id}/tracks': {
      put: {
        summary: 'Replace the ordered list of track IDs in a playlist',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['trackIds'], properties: { trackIds: { type: 'array', items: { type: 'string' } } } } } },
        },
        responses: {
          '200': { description: 'Tracks replaced' },
          '400': { description: 'body.trackIds must be an array of strings' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist' },
          '404': { description: 'Playlist not found' },
        },
      },
    },
    '/destinations': {
      post: {
        summary: 'Register a new custom RTMP streaming destination. body.provider must be \'custom\' or omitted — use GET /destinations/{provider}/oauth/start to connect a YouTube (or other OAuth) destination instead',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'rtmpUrl', 'streamKey'],
                properties: { name: { type: 'string' }, rtmpUrl: { type: 'string' }, streamKey: { type: 'string' }, provider: { type: 'string', enum: ['custom'] } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Destination created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Destination' } } } },
          '400': { description: 'Missing or invalid name/rtmpUrl/streamKey, or an unsupported provider' },
          '401': { description: 'Not authenticated' },
        },
      },
      get: {
        summary: 'List the authenticated user\'s destinations',
        responses: {
          '200': { description: 'Destination list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Destination' } } } } },
          '401': { description: 'Not authenticated' },
        },
      },
    },
    '/destinations/{id}': {
      delete: {
        summary: 'Delete a destination owned by the authenticated user',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Destination deleted' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
        },
      },
    },
    '/destinations/{provider}/oauth/start': {
      get: {
        summary: 'Begin connecting a streaming-platform account via OAuth2 (e.g. YouTube)',
        parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Auth URL to open in a browser', content: { 'application/json': { schema: { type: 'object', properties: { authUrl: { type: 'string' } } } } } },
          '401': { description: 'Not authenticated' },
          '404': { description: 'Unknown provider' },
        },
      },
    },
    '/destinations/{provider}/oauth/callback': {
      get: {
        summary: 'OAuth2 redirect target — exchanges the code and creates the destination',
        parameters: [
          { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Connected — an HTML confirmation page' },
          '400': { description: 'Missing/invalid code or state' },
          '404': { description: 'Unknown provider' },
        },
      },
    },
    '/destinations/{destinationId}/stream/start': {
      post: {
        summary: 'Start streaming a playlist to this destination',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['playlistId'],
                properties: {
                  playlistId: { type: 'string' },
                  templateId: { type: 'string', description: 'Optional overlay template id (see /templates). When omitted, a built-in default layout is used instead of erroring — no visual editor exists yet, so most streams will start without one.' },
                  title: { type: 'string', description: 'Optional broadcast title override (providers that create a live broadcast, e.g. YouTube); defaults to the playlist name' },
                  description: { type: 'string', description: 'Optional broadcast description (providers that create a live broadcast, e.g. YouTube)' },
                  privacyStatus: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'Optional broadcast privacy (providers that create a live broadcast, e.g. YouTube); defaults to private' },
                  latencyPreference: { type: 'string', enum: ['normal', 'low', 'ultraLow'], description: "Optional YouTube broadcast latency; defaults to 'normal' (YouTube's own default, and its highest end-to-end latency, ~20-40s). Ignored by providers that don't create a live broadcast (e.g. custom RTMP)." },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Stream started', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '400': { description: 'Missing body.playlistId, or an empty-string body.templateId' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination, or not your template' },
          '404': { description: 'Destination not found, or templateId given but not found' },
          '409': { description: 'Stream already active for this destination, or playlist is empty' },
        },
      },
    },
    '/destinations/{destinationId}/stream/stop': {
      post: {
        summary: 'Stop the stream for this destination',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Stream stopped', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
          '409': { description: 'Stream is not active' },
        },
      },
    },
    '/destinations/{destinationId}/stream/pause': {
      post: {
        summary: 'Pause playback for this destination (silence + background, RTMP stays connected)',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Stream paused', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
          '409': { description: 'Stream is not currently streaming' },
        },
      },
    },
    '/destinations/{destinationId}/stream/resume': {
      post: {
        summary: 'Resume playback of the current track from the position it was paused at',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Stream resumed', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
          '409': { description: 'Stream is not paused' },
        },
      },
    },
    '/destinations/{destinationId}/stream/next': {
      post: {
        summary: 'Skip to the next track in the queue',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Advanced to next track', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
          '409': { description: 'Stream is not active' },
        },
      },
    },
    '/destinations/{destinationId}/stream/previous': {
      post: {
        summary: 'Go back to the previous track',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Moved to previous track', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
          '409': { description: 'Stream is not active' },
        },
      },
    },
    '/destinations/{destinationId}/stream/play': {
      post: {
        summary: 'Queue a specific track by name to play next',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'Track queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '400': { description: 'Missing or invalid name' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found, or track not found' },
          '409': { description: 'Stream is not active' },
        },
      },
    },
    '/destinations/{destinationId}/stream/status': {
      get: {
        summary: 'Get the current stream status for this destination',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Current status', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
        },
      },
    },
    '/destinations/{destinationId}/stream/events': {
      get: {
        summary: 'Server-Sent Events stream of this destination\'s live status',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'text/event-stream — each event is a StreamStatus JSON payload' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
        },
      },
    },
    '/stream-sessions': {
      post: {
        summary: 'Start streaming a playlist to several destinations at once (e.g. YouTube + a custom RTMP target), fanned out to independent per-destination streams',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['playlistId', 'destinationIds'],
                properties: {
                  playlistId: { type: 'string' },
                  templateId: { type: 'string', description: 'Optional overlay template id (see /templates), shared by every destination in the session. Omitted -> the built-in default layout is used for all of them.' },
                  destinationIds: { type: 'array', items: { type: 'string' }, description: 'Must be non-empty and contain no duplicates' },
                  title: { type: 'string', description: 'Optional broadcast title override (providers that create a live broadcast, e.g. YouTube); defaults to the playlist name' },
                  description: { type: 'string', description: 'Optional broadcast description (providers that create a live broadcast, e.g. YouTube)' },
                  privacyStatus: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'Optional broadcast privacy (providers that create a live broadcast, e.g. YouTube); defaults to private' },
                  latencyPreference: { type: 'string', enum: ['normal', 'low', 'ultraLow'], description: "Optional YouTube broadcast latency; defaults to 'normal' (YouTube's own default, and its highest end-to-end latency, ~20-40s). Ignored by providers that don't create a live broadcast (e.g. custom RTMP)." },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Session created; each destination started independently — a per-destination `error` field means that one destination failed to start, not the whole session', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamSessionStatus' } } } },
          '400': { description: 'Missing/invalid playlistId or destinationIds, or an empty-string templateId' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist, not your destination, or not your template' },
          '404': { description: 'Playlist not found, a destination not found, or templateId given but not found' },
        },
      },
      get: {
        summary: 'List the authenticated user\'s stream sessions, each with live per-destination status',
        responses: {
          '200': { description: 'Session list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/StreamSessionStatus' } } } } },
          '401': { description: 'Not authenticated' },
        },
      },
    },
    '/stream-sessions/{id}': {
      delete: {
        summary: 'Stop every destination in this session (best-effort) and delete it',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Session stopped and deleted' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream session' },
          '404': { description: 'Stream session not found' },
        },
      },
    },
    '/stream-sessions/{id}/status': {
      get: {
        summary: 'Get the current status of every destination in this session',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Current status', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamSessionStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream session' },
          '404': { description: 'Stream session not found' },
        },
      },
    },
    '/stream-sessions/{id}/events': {
      get: {
        summary: 'Server-Sent Events stream of every destination\'s live status in this session',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'text/event-stream — each event is a StreamSessionStatus JSON payload' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream session' },
          '404': { description: 'Stream session not found' },
        },
      },
    },
    '/stream-sessions/{id}/pause': {
      post: {
        summary: 'Pause every destination in this session (best-effort, per destination)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Result per destination; a per-destination `error` means only that destination failed to pause', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamSessionStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream session' },
          '404': { description: 'Stream session not found' },
        },
      },
    },
    '/stream-sessions/{id}/resume': {
      post: {
        summary: 'Resume every destination in this session (best-effort, per destination)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Result per destination', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamSessionStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream session' },
          '404': { description: 'Stream session not found' },
        },
      },
    },
    '/stream-sessions/{id}/next': {
      post: {
        summary: 'Skip to the next track on every destination in this session (best-effort, per destination)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Result per destination', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamSessionStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream session' },
          '404': { description: 'Stream session not found' },
        },
      },
    },
    '/stream-sessions/{id}/previous': {
      post: {
        summary: 'Go back to the previous track on every destination in this session (best-effort, per destination)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Result per destination', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamSessionStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream session' },
          '404': { description: 'Stream session not found' },
        },
      },
    },
    '/stream-sessions/{id}/stop': {
      post: {
        summary: 'Stop every destination in this session (best-effort, per destination); the session row itself is left in place — use DELETE to remove it too',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Result per destination', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamSessionStatus' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream session' },
          '404': { description: 'Stream session not found' },
        },
      },
    },
    '/templates': {
      post: {
        summary: 'Create a named, reusable overlay template ("theme") — a positioned list of elements (cover art, title text, playlist window) rendered onto the stream video',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'elements'],
                properties: {
                  name: { type: 'string' },
                  elements: { type: 'array', items: { $ref: '#/components/schemas/TemplateElement' } },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Template created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Template' } } } },
          '400': { description: 'Missing/invalid name or elements' },
          '401': { description: 'Not authenticated' },
        },
      },
      get: {
        summary: 'List the authenticated user\'s templates',
        responses: {
          '200': { description: 'Template list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Template' } } } } },
          '401': { description: 'Not authenticated' },
        },
      },
    },
    '/templates/{id}': {
      get: {
        summary: 'Get a template',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Template', content: { 'application/json': { schema: { $ref: '#/components/schemas/Template' } } } },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your template' },
          '404': { description: 'Template not found' },
        },
      },
      put: {
        summary: 'Update a template\'s name and/or elements',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  elements: { type: 'array', items: { $ref: '#/components/schemas/TemplateElement' } },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Template updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Template' } } } },
          '400': { description: 'Invalid name or elements' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your template' },
          '404': { description: 'Template not found' },
        },
      },
      delete: {
        summary: 'Delete a template',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Template deleted' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your template' },
          '404': { description: 'Template not found' },
        },
      },
    },
    '/templates/{id}/preview': {
      post: {
        summary: 'Render a PNG preview of this template (or an unsaved draft, if body.elements is given) against sample scene data — for the visual editor\'s live preview, not persisted',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  elements: { type: 'array', items: { $ref: '#/components/schemas/TemplateElement' }, description: 'Optional unsaved draft — overrides the saved template\'s elements for this render only' },
                  title: { type: 'string', description: 'Optional sample title; defaults to a placeholder' },
                  playlistLines: { type: 'array', items: { type: 'string' }, description: 'Optional sample playlist-window lines; defaults to a placeholder' },
                  trackId: { type: 'string', description: 'Optional — use this track\'s real cover art instead of the default cover' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'image/png' },
          '400': { description: 'Invalid elements/title/playlistLines/trackId' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your template, or not your track' },
          '404': { description: 'Template not found, or track not found' },
        },
      },
    },
    '/auth/register': {
      post: {
        summary: 'Register a new user and start a session',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'User created', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          '400': { description: 'Missing or invalid email/password' },
          '409': { description: 'Email already registered' },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Log in and start a session',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'Logged in', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          '400': { description: 'Missing or invalid email/password' },
          '401': { description: 'Invalid email or password' },
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Log out and clear the session',
        responses: {
          '200': { description: 'Logged out' },
        },
      },
    },
    '/auth/me': {
      get: {
        summary: 'Get the current authenticated user',
        responses: {
          '200': { description: 'Current user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          '401': { description: 'Not authenticated' },
        },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
        },
      },
      TrackSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          durationSeconds: { type: 'number', nullable: true },
          hasCover: { type: 'boolean' },
        },
      },
      Playlist: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
      PlaylistWithTracks: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          tracks: { type: 'array', items: { $ref: '#/components/schemas/TrackSummary' } },
        },
      },
      Destination: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          rtmpUrl: { type: 'string', nullable: true },
          provider: { type: 'string' },
        },
      },
      StreamStatus: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['idle', 'streaming', 'paused', 'error'] },
          currentTrack: { type: 'string', nullable: true },
          nextTrack: { type: 'string', nullable: true },
          provider: {
            type: 'object',
            nullable: true,
            properties: {
              type: { type: 'string' },
              phase: { type: 'string' },
              watchUrl: { type: 'string', nullable: true },
            },
          },
        },
      },
      StreamSessionStatus: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          playlistId: { type: 'string' },
          templateId: { type: 'string', nullable: true },
          destinations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                destinationId: { type: 'string' },
                status: { $ref: '#/components/schemas/StreamStatus' },
                error: { type: 'string', description: 'Set only when this destination\'s own command failed — the other destinations in the session are unaffected' },
              },
            },
          },
        },
      },
      TemplateElement: {
        type: 'object',
        description: 'A positioned overlay element. `type` determines which other fields apply: `cover` needs width+height; `title`/`playlist` need width+fontSize+color.',
        required: ['type', 'x', 'y'],
        properties: {
          type: { type: 'string', enum: ['cover', 'title', 'playlist'] },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number', description: '`cover` only' },
          fontSize: { type: 'number', description: '`title`/`playlist` only' },
          color: { type: 'string', description: '`title`/`playlist` only — CSS color string' },
        },
      },
      Template: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          elements: { type: 'array', items: { $ref: '#/components/schemas/TemplateElement' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};
