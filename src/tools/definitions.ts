import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 project file with line numbers, or look at an image (PNG, JPEG, GIF or WebP) such as a screenshot or a rendered frame. Use offset and limit to page through large text files. Large images are downscaled to fit the model. Paths are relative to the project directory; symlinks may not escape it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: {
          type: 'integer',
          minimum: 1,
          description: 'First line, starting at 1. Default 1.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 2000,
          description: 'Maximum lines. Default 200.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 project file. Creates parent directories. Read existing content before overwriting it.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace text in a project file. Copy old_string from read_file output without the line-number prefix; write line breaks as \\n and the file keeps its CRLF or LF endings. If there is no exact match, quote, dash and space variants and then trailing whitespace are ignored. old_string must match exactly once unless replace_all is true; include surrounding text to disambiguate. new_string must be the complete text, never a placeholder such as "rest of code".',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', minLength: 1 },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description:
      'List immediate children of a project directory. Directory names end with /. Results are bounded.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Default project directory.' } },
    },
  },
  {
    name: 'glob',
    description:
      'Find project files by glob pattern, e.g. src/**/*.ts. Skips .git, dependencies, build output and symlinks. Results are bounded.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: {
          type: 'string',
          description: 'Directory to search, relative to the project. Default .',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      'Search text files for a JavaScript regular expression, or literal text with literal:true. Reports file:line:text. Search is bounded and times out after 10 seconds.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory to search. Default .' },
        glob: { type: 'string', description: 'Optional file pattern, e.g. **/*.ts.' },
        literal: { type: 'boolean', description: 'Treat pattern as plain text. Default false.' },
        ignore_case: { type: 'boolean', description: 'Default false.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the project directory. Captures stdout and stderr separately, with bounded output. timeout_ms defaults to 120000 and may be up to 1800000. Descendants are stopped on completion, timeout or cancellation; background jobs are not persistent. This tool is not a filesystem sandbox.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1, maximum: 1800000 },
      },
      required: ['command'],
    },
  },
  {
    name: 'skill',
    description:
      'Load the full instructions for a skill by name. Use the available skills index to choose a relevant skill before starting its workflow. Relative references resolve from the returned base directory.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'exit_plan_mode',
    description:
      'In plan mode, present the finished plan so the user can approve it before anything changes. Write it in Markdown: the goal, the files to change and how, and how the result will be verified. The result says whether to proceed or keep planning. Outside plan mode it does nothing.',
    input_schema: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'The complete plan in Markdown.' } },
      required: ['plan'],
    },
  },
];
