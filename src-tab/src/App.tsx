import React from 'react';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import {
    AdminConnection,
    GenericApp,
    Loader,
    type GenericAppProps,
    type GenericAppState,
} from '@iobroker/gui-components';

import { RecorderApi } from './api';
import { TimeMachine } from './components/TimeMachine';

import enLang from './i18n/en.json';
import deLang from './i18n/de.json';
import esLang from './i18n/es.json';
import frLang from './i18n/fr.json';
import itLang from './i18n/it.json';
import nlLang from './i18n/nl.json';
import plLang from './i18n/pl.json';
import ptLang from './i18n/pt.json';
import ruLang from './i18n/ru.json';
import ukLang from './i18n/uk.json';
import zhCnLang from './i18n/zh-cn.json';

interface AppState extends GenericAppState {
    ready: boolean;
}

/** The admin tab "Time machine": `GenericApp` supplies socket, theme, language and instance */
export default class App extends GenericApp<GenericAppProps, AppState> {
    private api: RecorderApi | null = null;

    public constructor(props: GenericAppProps) {
        super(props, {
            ...props,
            // @ts-expect-error the settings declare an instance of the connection, the class is expected
            Connection: AdminConnection,
            translations: {
                en: enLang,
                de: deLang,
                es: esLang,
                fr: frLang,
                it: itLang,
                nl: nlLang,
                pl: plLang,
                pt: ptLang,
                ru: ruLang,
                uk: ukLang,
                'zh-cn': zhCnLang,
            },
            bottomButtons: false,
            // the tab reads everything through sendTo: no need to load all objects
            doNotLoadAllObjects: true,
        });
        this.state = { ...this.state, ready: false };
    }

    public override onConnectionReady(): void {
        this.api = new RecorderApi(this.socket, `${this.adapterName}.${this.instance}`);
        this.setState({ ready: true });
    }

    public override render(): React.JSX.Element {
        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>
                    <CssBaseline />
                    {this.state.ready && this.api ? (
                        <TimeMachine api={this.api} />
                    ) : (
                        <Loader themeType={this.state.themeType} />
                    )}
                </ThemeProvider>
            </StyledEngineProvider>
        );
    }
}
