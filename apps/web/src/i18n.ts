import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../../../locales/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
  }
}

void i18n.use(initReactI18next).init({
  defaultNS: "translation",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
  lng: "en",
  resources: {
    en: {
      translation: en,
    },
  },
});

export default i18n;
