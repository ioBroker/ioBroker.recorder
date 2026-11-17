import { Types } from '@iobroker/type-detector';

export type CategoryKey =
    | 'light'
    | 'shading'
    | 'climate'
    | 'windowsDoors'
    | 'motion'
    | 'security'
    | 'sockets'
    | 'media'
    | 'weather'
    | 'energy';

/** off: not recorded, on: every change (with the frequency filter of milestone 3), aggregated: 5 minute aggregates */
export type CategoryMode = 'off' | 'on' | 'aggregated';

/** The `native` attributes that hold the mode of each category */
export type CategoryConfigKey =
    | 'catLight'
    | 'catShading'
    | 'catClimate'
    | 'catWindows'
    | 'catMotion'
    | 'catSecurity'
    | 'catSockets'
    | 'catMedia'
    | 'catWeather'
    | 'catEnergy';

export interface CategoryDefinition {
    key: CategoryKey;
    configKey: CategoryConfigKey;
    defaultMode: CategoryMode;
    label: { en: string; de: string };
    /** Device types of the type detector */
    types: Types[];
    /** Names of the detector states that are recorded; indicators, battery, RSSI etc. are not */
    states: string[];
    /** Fallback for states without a detected device: roles (exact or as prefix followed by a dot) */
    roles: string[];
}

/** States of any detected device that belong to the category "energy" */
export const ENERGY_STATES = ['ELECTRIC_POWER', 'CONSUMPTION'];

export const CATEGORIES: CategoryDefinition[] = [
    {
        key: 'light',
        configKey: 'catLight',
        defaultMode: 'on',
        label: { en: 'Light', de: 'Licht' },
        types: [
            Types.light,
            Types.dimmer,
            Types.ct,
            Types.rgb,
            Types.rgbSingle,
            Types.rgbwSingle,
            Types.hue,
            Types.cie,
        ],
        states: [
            'SET',
            'ACTUAL',
            'ON',
            'ON_SET',
            'ON_ACTUAL',
            'DIMMER',
            'BRIGHTNESS',
            'TEMPERATURE',
            'RGB',
            'RGBW',
            'HUE',
            'SATURATION',
            'CIE',
            'RED',
            'GREEN',
            'BLUE',
            'WHITE',
        ],
        roles: ['switch.light', 'level.dimmer'],
    },
    {
        key: 'shading',
        configKey: 'catShading',
        defaultMode: 'on',
        label: { en: 'Shading', de: 'Beschattung' },
        types: [Types.blind, Types.blindButtons],
        states: ['SET', 'ACTUAL', 'TILT_SET', 'TILT_ACTUAL'],
        roles: ['level.blind', 'value.blind', 'level.curtain'],
    },
    {
        key: 'climate',
        configKey: 'catClimate',
        defaultMode: 'on',
        label: { en: 'Heating and climate', de: 'Heizung und Klima' },
        types: [Types.thermostat, Types.airCondition, Types.temperature, Types.humidity, Types.illuminance],
        states: [
            'SET',
            'SET_HEATING',
            'SET_COOLING',
            'ACTUAL',
            'SECOND',
            'HUMIDITY',
            'BOOST',
            'POWER',
            'PARTY',
            'MODE',
            'VALVE',
            'WORKING_MODE',
            'WINDOW',
            'SPEED',
        ],
        roles: ['value.temperature', 'level.temperature', 'value.humidity', 'value.brightness'],
    },
    {
        key: 'windowsDoors',
        configKey: 'catWindows',
        defaultMode: 'on',
        label: { en: 'Windows and doors', de: 'Fenster und Türen' },
        types: [Types.window, Types.windowTilt, Types.door, Types.gate],
        states: ['ACTUAL', 'SET'],
        roles: ['sensor.window', 'sensor.door', 'value.window'],
    },
    {
        key: 'motion',
        configKey: 'catMotion',
        // privacy: motion and presence data show when somebody is at home
        defaultMode: 'off',
        label: { en: 'Motion and presence', de: 'Bewegung und Präsenz' },
        types: [Types.motion],
        states: ['ACTUAL'],
        roles: ['sensor.motion', 'sensor.presence', 'state.presence'],
    },
    {
        key: 'security',
        configKey: 'catSecurity',
        defaultMode: 'on',
        label: { en: 'Security', de: 'Sicherheit' },
        types: [Types.lock, Types.fireAlarm, Types.floodAlarm, Types.coAlarm],
        states: ['SET', 'ACTUAL', 'DOOR_STATE', 'CO', 'SEVERITY'],
        roles: ['switch.lock', 'sensor.alarm.fire', 'sensor.alarm.flood', 'sensor.alarm.secure'],
    },
    {
        key: 'sockets',
        configKey: 'catSockets',
        defaultMode: 'on',
        label: { en: 'Switches and sockets', de: 'Schalter und Steckdosen' },
        types: [Types.socket],
        states: ['SET', 'ACTUAL'],
        roles: [],
    },
    {
        key: 'media',
        configKey: 'catMedia',
        defaultMode: 'on',
        label: { en: 'Media', de: 'Medien' },
        types: [Types.media, Types.tv],
        // only on/off and the source, not titles, volume or covers
        states: ['STATE', 'POWER', 'INPUT', 'APP'],
        roles: [],
    },
    {
        key: 'weather',
        configKey: 'catWeather',
        defaultMode: 'on',
        label: { en: 'Weather', de: 'Wetter' },
        types: [Types.weatherCurrent, Types.weatherForecast],
        // current values only, no forecasts for the next days
        states: ['ACTUAL', 'TEMP', 'HUMIDITY', 'PRESSURE', 'WIND_SPEED', 'WIND_GUST', 'UV', 'PRECIPITATION_CHANCE'],
        roles: [],
    },
    {
        key: 'energy',
        configKey: 'catEnergy',
        defaultMode: 'aggregated',
        label: { en: 'Energy', de: 'Energie' },
        types: [Types.electricity],
        states: ENERGY_STATES,
        roles: ['value.power', 'value.energy'],
    },
];

const BY_KEY = new Map(CATEGORIES.map(c => [c.key, c]));
const BY_TYPE = new Map<string, CategoryDefinition>();
for (const category of CATEGORIES) {
    for (const type of category.types) {
        BY_TYPE.set(type, category);
    }
}

export function categoryByKey(key: CategoryKey): CategoryDefinition | undefined {
    return BY_KEY.get(key);
}

export function categoryOfType(type: Types | string): CategoryDefinition | undefined {
    return BY_TYPE.get(type);
}

function roleMatches(role: string, pattern: string): boolean {
    return role === pattern || role.startsWith(`${pattern}.`);
}

/** Category of a state by its role alone (fallback level of the selection) */
export function categoryOfRole(role: string | undefined): CategoryDefinition | undefined {
    if (!role) {
        return undefined;
    }
    return CATEGORIES.find(c => c.roles.some(r => roleMatches(role, r)));
}

/** Roles that are never recorded automatically: technical information, buttons, texts */
const NEGATIVE_ROLES = ['info', 'indicator.connected', 'indicator.reachable', 'text', 'json', 'url'];

export function isNegativeRole(role: string | undefined): boolean {
    if (!role) {
        return false;
    }
    if (role === 'button' || role.startsWith('button')) {
        return true;
    }
    return NEGATIVE_ROLES.some(r => roleMatches(role, r));
}

/** Reads the modes of all categories from the instance configuration */
export function categoryModes(config: Partial<Record<CategoryConfigKey, unknown>>): Record<CategoryKey, CategoryMode> {
    const modes = {} as Record<CategoryKey, CategoryMode>;
    for (const category of CATEGORIES) {
        const value = config[category.configKey];
        modes[category.key] =
            value === 'off' || value === 'on' || value === 'aggregated' ? value : category.defaultMode;
    }
    return modes;
}
