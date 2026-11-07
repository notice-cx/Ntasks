/**
 * The MCP tools for a project's custom fields, which NoticeOS's task tools did
 * not have: list a project's fields, define one and retire one. A task's
 * values are set with create_task, create_tasks and update_task, and
 * list_tasks filters by them.
 */
import { FIELD_TYPES, TASK_LIMITS, type DefineFieldInput, type FieldType } from '@ntasks/domain';
import { keyArg, only, projectArg, type Args } from '../args.ts';
import { SCOPES } from '../auth.ts';
import { defineField, fieldsOf, retireField } from '../task-writes.ts';
import { fieldView } from '../views.ts';
import { PROJECT, READ, schema, type TaskTool } from './read-tools.ts';
import { IDEMPOTENCY, retryRequest, WRITE } from './write-tools.ts';

const FIELD_KEY = Object.freeze({
  type: 'string',
  pattern: '^[a-z][a-z0-9_-]{0,63}$',
  description: 'The key that names the field in values and filters, such as severity.',
});

export const FIELD_TOOLS: readonly TaskTool[] = Object.freeze([
  {
    name: 'list_fields',
    description:
      "List a project's custom fields: each one's key, name, type and options, and when it was retired. " +
      'Tasks carry their values as fields; set them with create_task or update_task, and filter list_tasks by them.',
    inputSchema: schema({ project: PROJECT }, ['project']),
    annotations: READ,
    scope: SCOPES.read,
    async run(context, args) {
      only(args, ['project']);
      const { project, fields } = await fieldsOf(context, projectArg(args));
      return { project: project.key, fields: fields.map(fieldView) };
    },
  },
  {
    name: 'define_field',
    description:
      'Define a custom field in a project, which its tasks can then carry a value of. A key the project has used, ' +
      'retired or not, is refused.',
    inputSchema: schema(
      {
        project: PROJECT,
        key: FIELD_KEY,
        name: { type: 'string', maxLength: TASK_LIMITS.fieldName, description: 'One line: what people call it.' },
        type: {
          type: 'string',
          enum: FIELD_TYPES,
          description:
            'What a value is: text; a number; a date as YYYY-MM-DD; one option (single-choice); a list of options ' +
            '(multiple-choice); an http or https URL; true or false (yes-no).',
        },
        options: {
          type: 'array',
          minItems: 1,
          maxItems: TASK_LIMITS.fieldOptions,
          items: { type: 'string', maxLength: TASK_LIMITS.fieldOption },
          description: 'For a single-choice or multiple-choice field: its options, in order, none twice.',
        },
        idempotency_key: IDEMPOTENCY,
      },
      ['project', 'key', 'name', 'type', 'idempotency_key'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', 'key', 'name', 'type', 'options', 'idempotency_key']);
      const projectId = projectArg(args);
      keyArg(args);
      // The engine checks each part and names the one at fault.
      const input: DefineFieldInput = {
        key: args.key as string,
        name: args.name as string,
        type: args.type as FieldType,
        ...(args.options === undefined ? {} : { options: args.options as string[] }),
      };
      const { field, replayed } = await defineField(context, projectId, input, retryRequest('define_field', args));
      return { field: fieldView(field), replayed };
    },
  },
  {
    name: 'retire_field',
    description:
      'Retire a custom field: it takes no new values. Tasks keep the values they carry, and their history keeps ' +
      'every change. Retiring a retired field changes nothing.',
    inputSchema: schema({ project: PROJECT, field: FIELD_KEY, idempotency_key: IDEMPOTENCY }, [
      'project',
      'field',
      'idempotency_key',
    ]),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args: Args) {
      only(args, ['project', 'field', 'idempotency_key']);
      const projectId = projectArg(args);
      keyArg(args);
      const { field, replayed } = await retireField(
        context,
        projectId,
        args.field as string,
        retryRequest('retire_field', args),
      );
      return { field: fieldView(field), replayed };
    },
  },
] satisfies TaskTool[]);
