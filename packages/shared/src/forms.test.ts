import { describe, expect, it } from 'vitest';
import { defaultFieldsForService, essentialFields, FormDefinitionSchema } from './forms.js';

describe('formularios predeterminados', () => {
  it('incluye todos los campos esenciales en cada servicio', () => {
    const fields = defaultFieldsForService('PC_MAINTENANCE');
    expect(fields.filter((field) => field.essential).map((field) => field.key)).toEqual(
      essentialFields.map((field) => field.key),
    );
  });

  it('agrega relevamiento para cámaras, alarmas y redes', () => {
    for (const service of ['CAMERAS', 'ALARMS', 'WIFI_NETWORK', 'WIRED_NETWORK']) {
      const fields = defaultFieldsForService(service);
      expect(fields.some((field) => field.key === 'floors_or_rooms')).toBe(true);
      expect(fields.some((field) => field.key === 'equipment_plan')).toBe(true);
    }
  });

  it('produce una definición válida para el catálogo', () => {
    expect(
      FormDefinitionSchema.safeParse({
        serviceCode: 'CAMERAS',
        name: 'Relevamiento inicial',
        description: null,
        fields: defaultFieldsForService('CAMERAS'),
      }).success,
    ).toBe(true);
  });
});
