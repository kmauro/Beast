import { randomUUID } from 'node:crypto';
import type { BeastDatabase, DatabaseSchema } from '@beast/database';
import {
  defaultFieldsForService,
  essentialFields,
  FormFieldDefinitionSchema,
  type FormDetail,
  type FormFieldDefinition,
  type ServiceForms,
} from '@beast/shared';
import type { FastifyInstance } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';

const IdParamsSchema = z.object({ id: z.string().uuid() });

const CreateFormSchema = z.object({
  serviceId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().default(null),
});

const DraftSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).nullable().default(null),
    fields: z.array(FormFieldDefinitionSchema).min(1).max(100),
  })
  .superRefine((form, context) => {
    const keys = new Set<string>();
    for (const [index, field] of form.fields.entries()) {
      if (keys.has(field.key)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: 'La clave del campo está repetida',
        });
      }
      keys.add(field.key);

      const isChoice = field.type === 'SINGLE_CHOICE' || field.type === 'MULTIPLE_CHOICE';
      if (isChoice && field.options.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'options'],
          message: 'Los campos de opciones necesitan al menos una opción',
        });
      }
    }

    for (const essential of essentialFields) {
      const field = form.fields.find((candidate) => candidate.key === essential.key);
      if (!field) {
        context.addIssue({
          code: 'custom',
          path: ['fields'],
          message: `Falta el campo esencial ${essential.label}`,
        });
      } else if (!field.required || !field.essential) {
        context.addIssue({
          code: 'custom',
          path: ['fields', form.fields.indexOf(field)],
          message: `${essential.label} debe permanecer requerido y esencial`,
        });
      }
    }

    for (const [index, field] of form.fields.entries()) {
      if (field.visibleWhen && !keys.has(field.visibleWhen.fieldKey)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'visibleWhen'],
          message: 'La condición depende de un campo inexistente',
        });
      }
    }
  });

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toBoolean(value: boolean | number): boolean {
  return value === true || value === 1;
}

async function insertFields(
  transaction: Transaction<DatabaseSchema>,
  versionId: string,
  fields: FormFieldDefinition[],
): Promise<void> {
  if (fields.length === 0) return;

  await transaction
    .insertInto('form_fields')
    .values(
      fields.map((field, index) => ({
        id: randomUUID(),
        form_version_id: versionId,
        field_key: field.key,
        label: field.label,
        question: field.question,
        help_text: field.helpText,
        field_type: field.type,
        required: field.required,
        essential: field.essential,
        include_in_summary: field.includeInSummary,
        options_json: field.options.length > 0 ? JSON.stringify(field.options) : null,
        visible_when_json: field.visibleWhen ? JSON.stringify(field.visibleWhen) : null,
        validation_json: null,
        display_order: field.displayOrder ?? (index + 1) * 10,
      })),
    )
    .execute();
}

async function writeAudit(
  transaction: Transaction<DatabaseSchema>,
  action: string,
  entityId: string,
  after: unknown,
): Promise<void> {
  await transaction
    .insertInto('audit_log')
    .values({
      actor_user_id: null,
      action,
      entity_type: 'form_template',
      entity_id: entityId,
      before_json: null,
      after_json: JSON.stringify(after),
    })
    .execute();
}

async function loadFormDetail(db: BeastDatabase, templateId: string): Promise<FormDetail | null> {
  const template = await db
    .selectFrom('form_templates as template')
    .innerJoin('service_catalog as service', 'service.id', 'template.service_id')
    .select([
      'template.id',
      'template.service_id',
      'template.name',
      'template.description',
      'template.active',
      'service.code as service_code',
      'service.name as service_name',
    ])
    .where('template.id', '=', templateId)
    .executeTakeFirst();

  if (!template) return null;

  const versions = await db
    .selectFrom('form_versions')
    .select(['id', 'version_number', 'status'])
    .where('template_id', '=', templateId)
    .orderBy('version_number', 'desc')
    .execute();
  const selected =
    versions.find((version) => version.status === 'DRAFT') ??
    versions.find((version) => version.status === 'PUBLISHED') ??
    versions[0];

  if (!selected) return null;

  const fields = await db
    .selectFrom('form_fields')
    .selectAll()
    .where('form_version_id', '=', selected.id)
    .orderBy('display_order', 'asc')
    .execute();

  return {
    id: template.id,
    serviceId: template.service_id,
    serviceCode: template.service_code,
    serviceName: template.service_name,
    name: template.name,
    description: template.description,
    active: toBoolean(template.active),
    draftVersion: versions.find((version) => version.status === 'DRAFT')?.version_number ?? null,
    publishedVersion:
      versions.find((version) => version.status === 'PUBLISHED')?.version_number ?? null,
    version: {
      id: selected.id,
      versionNumber: selected.version_number,
      status: selected.status,
      fields: fields.map((field) => ({
        key: field.field_key,
        label: field.label,
        question: field.question,
        helpText: field.help_text,
        type: field.field_type,
        required: toBoolean(field.required),
        essential: toBoolean(field.essential),
        includeInSummary: toBoolean(field.include_in_summary),
        options: parseJson<string[]>(field.options_json, []),
        displayOrder: field.display_order,
        visibleWhen: parseJson<FormFieldDefinition['visibleWhen']>(
          field.visible_when_json,
          null,
        ),
      })),
    },
  };
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

export async function registerFormRoutes(app: FastifyInstance, db: BeastDatabase): Promise<void> {
  app.get('/forms', async () => {
    const [services, templates, versions] = await Promise.all([
      db
        .selectFrom('service_catalog')
        .select(['id', 'code', 'name', 'description'])
        .where('active', '=', true)
        .orderBy('display_order', 'asc')
        .execute(),
      db
        .selectFrom('form_templates')
        .select(['id', 'service_id', 'name', 'description', 'active'])
        .orderBy('name', 'asc')
        .execute(),
      db
        .selectFrom('form_versions')
        .select(['template_id', 'version_number', 'status'])
        .orderBy('version_number', 'desc')
        .execute(),
    ]);

    return services.map(
      (service): ServiceForms => ({
        id: service.id,
        code: service.code,
        name: service.name,
        description: service.description,
        templates: templates
          .filter((template) => template.service_id === service.id)
          .map((template) => {
            const templateVersions = versions.filter(
              (version) => version.template_id === template.id,
            );
            return {
              id: template.id,
              name: template.name,
              description: template.description,
              active: toBoolean(template.active),
              draftVersion:
                templateVersions.find((version) => version.status === 'DRAFT')
                  ?.version_number ?? null,
              publishedVersion:
                templateVersions.find((version) => version.status === 'PUBLISHED')
                  ?.version_number ?? null,
            };
          }),
      }),
    );
  });

  app.get('/forms/:id', async (request, reply) => {
    const parsed = IdParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_FORM_ID' });

    const form = await loadFormDetail(db, parsed.data.id);
    return form ?? reply.code(404).send({ error: 'FORM_NOT_FOUND' });
  });

  app.post('/forms', async (request, reply) => {
    const parsed = CreateFormSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_FORM', issues: parsed.error.issues });
    }

    const service = await db
      .selectFrom('service_catalog')
      .select(['id', 'code'])
      .where('id', '=', parsed.data.serviceId)
      .where('active', '=', true)
      .executeTakeFirst();
    if (!service) return reply.code(404).send({ error: 'SERVICE_NOT_FOUND' });

    const templateId = randomUUID();
    const versionId = randomUUID();

    try {
      await db.transaction().execute(async (transaction) => {
        await transaction
          .insertInto('form_templates')
          .values({
            id: templateId,
            service_id: service.id,
            name: parsed.data.name,
            description: parsed.data.description,
            active: true,
          })
          .execute();
        await transaction
          .insertInto('form_versions')
          .values({
            id: versionId,
            template_id: templateId,
            version_number: 1,
            status: 'DRAFT',
            created_by: null,
            published_at: null,
          })
          .execute();
        await insertFields(transaction, versionId, defaultFieldsForService(service.code));
        await writeAudit(transaction, 'FORM_CREATED', templateId, parsed.data);
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        return reply.code(409).send({ error: 'FORM_NAME_ALREADY_EXISTS' });
      }
      throw error;
    }

    const created = await loadFormDetail(db, templateId);
    return reply.code(201).send(created);
  });

  app.put('/forms/:id/draft', async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const body = DraftSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: 'INVALID_FORM',
        issues: body.success ? [] : body.error.issues,
      });
    }

    const template = await db
      .selectFrom('form_templates')
      .select('id')
      .where('id', '=', params.data.id)
      .executeTakeFirst();
    if (!template) return reply.code(404).send({ error: 'FORM_NOT_FOUND' });

    try {
      await db.transaction().execute(async (transaction) => {
        const versions = await transaction
          .selectFrom('form_versions')
          .select(['id', 'version_number', 'status'])
          .where('template_id', '=', template.id)
          .orderBy('version_number', 'desc')
          .execute();
        let draft = versions.find((version) => version.status === 'DRAFT');

        if (!draft) {
          draft = {
            id: randomUUID(),
            version_number: (versions[0]?.version_number ?? 0) + 1,
            status: 'DRAFT',
          };
          await transaction
            .insertInto('form_versions')
            .values({
              id: draft.id,
              template_id: template.id,
              version_number: draft.version_number,
              status: 'DRAFT',
              created_by: null,
              published_at: null,
            })
            .execute();
        } else {
          await transaction
            .deleteFrom('form_fields')
            .where('form_version_id', '=', draft.id)
            .execute();
        }

        await transaction
          .updateTable('form_templates')
          .set({ name: body.data.name, description: body.data.description })
          .where('id', '=', template.id)
          .execute();
        await insertFields(transaction, draft.id, body.data.fields);
        await writeAudit(transaction, 'FORM_DRAFT_SAVED', template.id, {
          version: draft.version_number,
          fieldCount: body.data.fields.length,
        });
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        return reply.code(409).send({ error: 'FORM_NAME_OR_FIELD_KEY_ALREADY_EXISTS' });
      }
      throw error;
    }

    return loadFormDetail(db, template.id);
  });

  app.post('/forms/:id/publish', async (request, reply) => {
    const parsed = IdParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_FORM_ID' });

    const result = await db.transaction().execute(async (transaction) => {
      const draft = await transaction
        .selectFrom('form_versions')
        .select(['id', 'version_number'])
        .where('template_id', '=', parsed.data.id)
        .where('status', '=', 'DRAFT')
        .executeTakeFirst();
      if (!draft) return false;

      const fieldCount = await transaction
        .selectFrom('form_fields')
        .select((expression) => expression.fn.countAll<number>().as('total'))
        .where('form_version_id', '=', draft.id)
        .executeTakeFirstOrThrow();
      if (Number(fieldCount.total) === 0) return false;

      await transaction
        .updateTable('form_versions')
        .set({ status: 'RETIRED' })
        .where('template_id', '=', parsed.data.id)
        .where('status', '=', 'PUBLISHED')
        .execute();
      await transaction
        .updateTable('form_versions')
        .set({ status: 'PUBLISHED', published_at: new Date() })
        .where('id', '=', draft.id)
        .execute();
      await writeAudit(transaction, 'FORM_PUBLISHED', parsed.data.id, {
        version: draft.version_number,
      });
      return true;
    });

    if (!result) return reply.code(409).send({ error: 'FORM_HAS_NO_DRAFT' });
    return loadFormDetail(db, parsed.data.id);
  });
}
