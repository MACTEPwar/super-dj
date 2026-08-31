export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Super DJ Streamer API',
    version: '1.0.0',
    description: 'Controls a continuous YouTube Live audio stream with a Now Playing video screen.',
  },
  paths: {
    '/stream/start': {
      post: {
        summary: 'Start the stream',
        responses: {
          '200': { description: 'Stream started', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream already active or library empty' },
        },
      },
    },
    '/stream/stop': {
      post: {
        summary: 'Stop the stream',
        responses: {
          '200': { description: 'Stream stopped', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not active' },
        },
      },
    },
    '/stream/pause': {
      post: {
        summary: 'Pause playback (silence + background, RTMP stays connected)',
        responses: {
          '200': { description: 'Stream paused', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not currently streaming' },
        },
      },
    },
    '/stream/resume': {
      post: {
        summary: 'Resume playback of the current track from the position it was paused at',
        responses: {
          '200': { description: 'Stream resumed', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not paused' },
        },
      },
    },
    '/stream/next': {
      post: {
        summary: 'Skip to the next track in the queue',
        responses: {
          '200': { description: 'Advanced to next track', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not active or queue is empty' },
        },
      },
    },
    '/stream/previous': {
      post: {
        summary: 'Go back to the previous track',
        responses: {
          '200': { description: 'Moved to previous track', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not active' },
        },
      },
    },
    '/stream/play': {
      post: {
        summary: 'Queue a specific track by name to play next',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'Track queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '400': { description: 'Missing or invalid name' },
          '404': { description: 'Track not found' },
        },
      },
    },
    '/stream/status': {
      get: {
        summary: 'Get current stream status',
        responses: {
          '200': { description: 'Current status', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
        },
      },
    },
    '/library': {
      get: {
        summary: 'List tracks currently in the library',
        responses: {
          '200': { description: 'Track list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Track' } } } } },
        },
      },
    },
    '/library/rescan': {
      post: {
        summary: 'Rescan the audio directory and update the library',
        responses: {
          '200': { description: 'Updated track list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Track' } } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      Track: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          audioPath: { type: 'string' },
          coverPath: { type: 'string', nullable: true },
        },
      },
      StreamStatus: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['idle', 'streaming', 'paused', 'error'] },
          currentTrack: { type: 'string', nullable: true },
          nextTrack: { type: 'string', nullable: true },
        },
      },
    },
  },
};
