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
      patch: {
        summary: 'Set (or clear) this track\'s per-track overlay override — colors applied on top of the selected template while this track is playing',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['overlayOverride'],
                properties: {
                  overlayOverride: { allOf: [{ $ref: '#/components/schemas/TrackOverlayOverride' }], nullable: true, description: 'null clears the override' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Override saved' },
          '400': { description: 'body.overlayOverride is missing or invalid' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your track' },
          '404': { description: 'Track not found' },
        },
      },
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
    '/local-stream/start': {
      post: {
        summary: 'Start this account\'s single local stream — encoded once and published to the internal relay, with no destination receiving it',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['playlistId'],
                properties: {
                  playlistId: { type: 'string' },
                  templateId: { type: 'string', description: 'Optional overlay template id (see /templates). Omitted -> the built-in default layout.' },
                  destinationIds: { type: 'array', items: { type: 'string' }, description: 'Optional destinations to switch on as soon as the stream is publishing. May be omitted or empty — a local stream with nothing forwarded is a fully valid running state. No duplicates.' },
                  title: { type: 'string', description: 'Optional broadcast title for any destination that creates a live broadcast (e.g. YouTube); defaults to the playlist name' },
                  description: { type: 'string', description: 'Optional broadcast description (destinations that create a live broadcast)' },
                  privacyStatus: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'Optional broadcast privacy; defaults to private' },
                  latencyPreference: { type: 'string', enum: ['normal', 'low', 'ultraLow'], description: "Optional YouTube broadcast latency; defaults to 'normal'" },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Started', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } },
          '400': { description: 'Missing playlistId, an empty-string templateId, or invalid destinationIds/broadcast fields' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist, template or destination' },
          '404': { description: 'Playlist, template or destination not found' },
          '409': { description: 'A local stream is already active (or starting) for this account, or the playlist is empty' },
          '429': { description: 'Too many local streams are running on this host' },
        },
      },
    },
    '/local-stream/stop': {
      post: { summary: 'Stop this account\'s local stream', responses: { '200': { description: 'Stopped', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active' } } },
    },
    '/local-stream/pause': {
      post: { summary: 'Pause playback (the local publish itself never stops, so the preview keeps working)', responses: { '200': { description: 'Paused', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active, or it is not currently streaming' } } },
    },
    '/local-stream/resume': {
      post: { summary: 'Resume playback from the paused position', responses: { '200': { description: 'Resumed', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active, or it is not paused' } } },
    },
    '/local-stream/next': {
      post: { summary: 'Skip to the next track', responses: { '200': { description: 'Skipped', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active' } } },
    },
    '/local-stream/previous': {
      post: { summary: 'Go back to the previous track', responses: { '200': { description: 'Moved back', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active' } } },
    },
    '/local-stream/play': {
      post: {
        summary: 'Queue one of this user\'s tracks to play next',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } },
        responses: { '200': { description: 'Queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '400': { description: 'Missing name' }, '401': { description: 'Not authenticated' }, '404': { description: 'Track not found in this user\'s library' }, '409': { description: 'No local stream is active' } },
      },
    },
    '/local-stream/destinations/{destinationId}': {
      put: {
        summary: 'Switch one destination\'s forward on or off for this account\'s local stream',
        description: 'Idempotent. Valid in every state, including with no local stream running — the forward then sits at `pending` with no external side effects until the next start. Never interrupts the local stream or any other destination.',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['desired'], properties: { desired: { type: 'string', enum: ['on', 'off'] } } } } },
        },
        responses: {
          '200': { description: 'Intent recorded', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } },
          '400': { description: 'body.desired must be on or off, or the request was not application/json' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
        },
      },
    },
    '/local-stream/status': {
      get: { summary: 'Current state of this account\'s local stream', responses: { '200': { description: 'Current status', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' } } },
    },
    '/local-stream/events': {
      get: { summary: 'Server-Sent Events stream of this account\'s local stream status', responses: { '200': { description: 'text/event-stream — each event is a LocalStreamStatus JSON payload' }, '401': { description: 'Not authenticated' } } },
    },
    '/local-stream/preview/index.m3u8': {
      get: {
        summary: 'HLS multivariant playlist for this account\'s own local stream, proxied from the internal relay',
        description: 'The caller never names a stream or path: it is resolved server-side from the authenticated session. Responses are never cacheable. A 404 shortly after starting is normal — the relay muxes HLS on demand; retry.',
        responses: { '200': { description: 'application/vnd.apple.mpegurl' }, '401': { description: 'Not authenticated' }, '404': { description: 'The relay has not produced a playlist yet' }, '409': { description: 'No local stream is active' }, '502': { description: 'The relay could not be reached' } },
      },
    },
    '/local-stream/preview/{file}': {
      get: {
        summary: 'One HLS artefact (media playlist or segment) referenced by the multivariant playlist above',
        parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string' }, description: 'A plain HLS file name such as stream.m3u8 or segment0.ts — anything else is rejected' }],
        responses: { '200': { description: 'The playlist or segment' }, '400': { description: 'Invalid preview file name' }, '401': { description: 'Not authenticated' }, '404': { description: 'Not produced by the relay' }, '409': { description: 'No local stream is active' }, '502': { description: 'The relay could not be reached' } },
      },
    },
    '/stream-presets': {
      post: {
        summary: 'Save a named preset — playlist, overlay template, destination checklist and broadcast metadata — to pre-populate a future local-stream start with',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'playlistId'],
                properties: {
                  name: { type: 'string' },
                  playlistId: { type: 'string' },
                  templateId: { type: 'string', nullable: true },
                  destinationIds: { type: 'array', items: { type: 'string' }, description: 'May be empty: a preset that forwards nowhere is valid' },
                  title: { type: 'string', nullable: true },
                  description: { type: 'string', nullable: true },
                  privacyStatus: { type: 'string', enum: ['public', 'unlisted', 'private'], nullable: true },
                  latencyPreference: { type: 'string', enum: ['normal', 'low', 'ultraLow'], nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Preset created', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamPreset' } } } },
          '400': { description: 'Missing/invalid name, playlistId, destinationIds or broadcast fields' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist, template or destination' },
          '404': { description: 'Playlist, template or destination not found' },
        },
      },
      get: {
        summary: 'List the authenticated user\'s saved presets',
        responses: {
          '200': { description: 'Preset list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/StreamPreset' } } } } },
          '401': { description: 'Not authenticated' },
        },
      },
    },
    '/stream-presets/{id}': {
      get: {
        summary: 'Get one saved preset',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Preset', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamPreset' } } } },
          '401': { description: 'Not authenticated' }, '403': { description: 'Not your stream preset' }, '404': { description: 'Not found' },
        },
      },
      put: {
        summary: 'Replace a saved preset (the destination checklist is replaced, not merged)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamPreset' } } } },
        responses: {
          '200': { description: 'Preset updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamPreset' } } } },
          '400': { description: 'Missing/invalid fields' }, '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream preset' }, '404': { description: 'Not found' },
        },
      },
      delete: {
        summary: 'Delete a saved preset',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Preset deleted' }, '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream preset' }, '404': { description: 'Not found' },
        },
      },
    },
    '/templates': {
      post: {
        summary: 'Create a named, reusable overlay template ("theme") — a positioned list of elements (cover art, title text, playlist window, elapsed timer, literal text, uploaded images) rendered onto the stream video',
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
    '/templates/fonts': {
      get: {
        summary: 'List the font families a template element\'s style.fontFamily may name (the server-installed set — the same list the visual editor offers)',
        responses: {
          '200': { description: 'Font family list', content: { 'application/json': { schema: { type: 'object', properties: { families: { type: 'array', items: { type: 'string' } } } } } } },
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
    '/templates/{id}/images': {
      post: {
        summary: 'Upload an image for this template (multipart/form-data: image). Converted to PNG server-side; the returned assetId is what an `image` element references.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image'],
                properties: { image: { type: 'string', format: 'binary', description: 'image/png, image/jpeg or image/gif; max 10 MiB' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Image stored', content: { 'application/json': { schema: { type: 'object', properties: { assetId: { type: 'string' } } } } } },
          '400': { description: 'Missing image file, unsupported image type, or file too large' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your template' },
          '404': { description: 'Template not found' },
        },
      },
    },
    '/templates/{id}/images/{assetId}': {
      get: {
        summary: 'Fetch a previously uploaded template image as PNG',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'assetId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'image/png' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your template' },
          '404': { description: 'Template not found, or no such image (a malformed assetId is reported as 404, not 400)' },
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
      LocalStreamStatus: {
        type: 'object',
        description: 'One local stream plus its 0..N independently toggleable destination forwards. An empty `destinations` array is a normal running state, not an error.',
        properties: {
          local: {
            type: 'object',
            properties: {
              state: { type: 'string', enum: ['idle', 'starting', 'streaming', 'paused', 'error', 'reconnecting'] },
              currentTrack: { type: 'string', nullable: true },
              nextTrack: { type: 'string', nullable: true },
              previewReady: { type: 'boolean', description: 'True while the encoder is publishing — including while paused, since pausing only swaps the audio' },
              playlistId: { type: 'string', nullable: true },
              templateId: { type: 'string', nullable: true },
              startedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          destinations: { type: 'array', items: { $ref: '#/components/schemas/DestinationForwardStatus' } },
        },
      },
      DestinationForwardStatus: {
        type: 'object',
        properties: {
          destinationId: { type: 'string' },
          name: { type: 'string' },
          desired: { type: 'string', enum: ['on', 'off'], description: 'What the user asked for' },
          state: {
            type: 'string',
            enum: ['off', 'pending', 'preparing', 'connecting', 'live', 'stopping', 'error'],
            description: '`pending` = wanted, but nothing is publishing locally yet (no external side effects have happened). `connecting` = a relay is running but the destination has not confirmed it; for YouTube this legitimately takes 10-40s.',
          },
          provider: {
            type: 'object',
            nullable: true,
            description: 'Present only for a destination with a broadcast lifecycle (YouTube).',
            properties: {
              type: { type: 'string' },
              phase: { type: 'string' },
              watchUrl: { type: 'string', nullable: true, description: "The channel's stable /live link for a public broadcast (survives every toggle); a per-broadcast link, fresh on every toggle, for an unlisted/private one or when no channel id is known" },
            },
          },
          error: {
            type: 'object',
            nullable: true,
            properties: {
              reason: { type: 'string', enum: ['auth', 'provider', 'relay', 'source'] },
              message: { type: 'string' },
            },
          },
        },
      },
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
          overlayOverride: { allOf: [{ $ref: '#/components/schemas/TrackOverlayOverride' }], nullable: true, description: 'null when this track has no per-track overlay override (see PATCH /tracks/{id})' },
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
      StreamPreset: {
        type: 'object',
        description: 'A saved choice, not a running thing: the playlist, template, destination checklist and broadcast metadata to pre-populate a local-stream start with.',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          playlistId: { type: 'string' },
          templateId: { type: 'string', nullable: true },
          destinationIds: { type: 'array', items: { type: 'string' } },
          title: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
          privacyStatus: { type: 'string', nullable: true },
          latencyPreference: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ColorValue: {
        type: 'object',
        description: 'A solid color, or a linear/radial gradient with 2-6 positioned stops. Every color component is a hex string (#RGB / #RGBA / #RRGGBB / #RRGGBBAA) — other CSS color syntaxes are rejected. `conic` is deliberately not offered: the renderer cannot draw it.',
        oneOf: [
          {
            type: 'object',
            required: ['mode', 'color'],
            properties: {
              mode: { type: 'string', enum: ['solid'] },
              color: { type: 'string', example: '#ffffff' },
            },
          },
          {
            type: 'object',
            required: ['mode', 'gradientType', 'stops', 'angleDeg'],
            properties: {
              mode: { type: 'string', enum: ['gradient'] },
              gradientType: { type: 'string', enum: ['linear', 'radial'] },
              stops: {
                type: 'array',
                minItems: 2,
                maxItems: 6,
                items: {
                  type: 'object',
                  required: ['color', 'offset'],
                  properties: {
                    color: { type: 'string', example: '#ffffff' },
                    offset: { type: 'number', minimum: 0, maximum: 100, description: 'Position along the gradient axis, in percent' },
                  },
                },
              },
              angleDeg: { type: 'number', minimum: 0, maximum: 360, description: 'Applies to `linear` only; retained but ignored for `radial`' },
            },
          },
        ],
      },
      TextStyle: {
        type: 'object',
        description: 'Typography and text decoration shared by the `title`/`playlist`/`timer`/`text` element types.',
        required: ['fontFamily', 'bold', 'italic'],
        properties: {
          fontFamily: { type: 'string', description: 'One of the families listed by GET /templates/fonts' },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          stroke: {
            type: 'object',
            description: 'Optional text outline',
            required: ['color', 'width'],
            properties: {
              color: { type: 'string', description: 'Hex color' },
              width: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 50 },
            },
          },
          shadow: {
            type: 'object',
            description: 'Optional drop shadow. The numeric bounds are enforced (not advisory) — extreme values crash the native rasterizer.',
            required: ['color', 'blur', 'offsetX', 'offsetY'],
            properties: {
              color: { type: 'string', description: 'Hex color' },
              blur: { type: 'number', minimum: 0, maximum: 100 },
              offsetX: { type: 'number', minimum: -100, maximum: 100 },
              offsetY: { type: 'number', minimum: -100, maximum: 100 },
            },
          },
        },
      },
      TemplateElement: {
        type: 'object',
        description: [
          'A positioned overlay element in a 1280x720 canvas coordinate space. `type` determines which other fields apply:',
          '`cover` needs width+height;',
          '`title`/`playlist` need width+fontSize+color(ColorValue)+style;',
          '`text` needs the same as `title` plus a literal `text` string (1-500 chars);',
          '`timer` needs fontSize+style plus a PLAIN hex-string `color` (not a ColorValue — it is drawn via ffmpeg drawtext, which cannot render gradient text) and takes no width;',
          '`image` needs width+height+assetId (an id issued by POST /templates/{id}/images).',
        ].join(' '),
        required: ['type', 'x', 'y'],
        properties: {
          type: { type: 'string', enum: ['cover', 'title', 'playlist', 'timer', 'text', 'image'] },
          x: { type: 'number', minimum: 0, maximum: 1280 },
          y: { type: 'number', minimum: 0, maximum: 720 },
          width: { type: 'number', description: 'all types except `timer`' },
          height: { type: 'number', description: '`cover`/`image` only' },
          fontSize: { type: 'number', maximum: 300, description: '`title`/`playlist`/`timer`/`text` only' },
          text: { type: 'string', maxLength: 500, description: '`text` only — the literal string to draw' },
          assetId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: '`image` only — an asset id returned by POST /templates/{id}/images' },
          color: {
            oneOf: [
              { $ref: '#/components/schemas/ColorValue' },
              { type: 'string', description: '`timer` only — a plain hex color string' },
            ],
            description: '`title`/`playlist`/`text` use the ColorValue union; `timer` uses a plain hex string',
          },
          style: { $ref: '#/components/schemas/TextStyle', description: '`title`/`playlist`/`timer`/`text` only' },
        },
      },
      TrackOverlayOverride: {
        type: 'object',
        description: 'Per-track overrides applied on top of the selected template when this track is playing. Both fields are optional; an absent field leaves the template\'s own value in place.',
        properties: {
          color: { $ref: '#/components/schemas/ColorValue' },
          backgroundColor: { $ref: '#/components/schemas/ColorValue' },
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
