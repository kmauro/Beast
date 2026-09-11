import { z } from 'zod';
import { ServiceCodeSchema } from './conversation.js';

export const formFieldTypes = [
  'TEXT',
  'LONG_TEXT',
  'INTEGER',
  'BOOLEAN',
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
] as const;

export const FormFieldTypeSchema = z.enum(formFieldTypes);

export const FormFieldDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(120),
  question: z.string().min(1).max(1000),
  helpText: z.string().max(1000).nullable().default(null),
  type: FormFieldTypeSchema,
  required: z.boolean().default(false),
  includeInSummary: z.boolean().default(true),
  options: z.array(z.string().min(1).max(120)).default([]),
  displayOrder: z.number().int().nonnegative(),
  visibleWhen: z
    .object({
      fieldKey: z.string(),
      operator: z.enum(['EQUALS', 'NOT_EQUALS', 'CONTAINS']),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .nullable()
    .default(null),
});

export const FormDefinitionSchema = z.object({
  serviceCode: ServiceCodeSchema,
  name: z.string().min(1).max(160),
  description: z.string().max(1000).nullable().default(null),
  fields: z.array(FormFieldDefinitionSchema).min(1),
});

export type FormFieldDefinition = z.infer<typeof FormFieldDefinitionSchema>;
export type FormDefinition = z.infer<typeof FormDefinitionSchema>;

export const essentialFields: FormFieldDefinition[] = [
  {
    key: 'customer_name',
    label: 'Nombre',
    question: '¿Cuál es tu nombre?',
    helpText: null,
    type: 'TEXT',
    required: true,
    includeInSummary: true,
    options: [],
    displayOrder: 10,
    visibleWhen: null,
  },
  {
    key: 'locality',
    label: 'Localidad o barrio',
    question: '¿En qué localidad o barrio se realizaría el trabajo?',
    helpText: null,
    type: 'TEXT',
    required: true,
    includeInSummary: true,
    options: [],
    displayOrder: 20,
    visibleWhen: null,
  },
  {
    key: 'property_type',
    label: 'Tipo de inmueble',
    question: '¿Es una residencia, local, oficina u otro tipo de inmueble?',
    helpText: null,
    type: 'SINGLE_CHOICE',
    required: true,
    includeInSummary: true,
    options: ['Residencia', 'Local', 'Oficina', 'Otro'],
    displayOrder: 30,
    visibleWhen: null,
  },
  {
    key: 'request_description',
    label: 'Descripción',
    question: 'Contanos brevemente qué necesitás resolver.',
    helpText: null,
    type: 'LONG_TEXT',
    required: true,
    includeInSummary: true,
    options: [],
    displayOrder: 40,
    visibleWhen: null,
  },
  {
    key: 'urgency',
    label: 'Urgencia',
    question: '¿Se trata de una urgencia?',
    helpText: null,
    type: 'BOOLEAN',
    required: true,
    includeInSummary: true,
    options: [],
    displayOrder: 50,
    visibleWhen: null,
  },
];

