import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
    name: "ManhwaWeb",
    description: "Lectura directa desde ManhwaWeb con API rápida",
    version: "1.1.3",
    icon: "icon.png",
    language: "es",
    contentRating: ContentRating.MATURE,
    capabilities: [
        SourceIntents.DISCOVER_SECTION_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.CHAPTER_PROVIDING,
        SourceIntents.SETTINGS_FORM_PROVIDING,
    ],
    badges: [{ label: "Español", textColor: "#ffffff", backgroundColor: "#2563eb" }],
    developers: [{ name: "Felii", github: "https://github.com/feliivk" }],
} satisfies ExtensionInfo;
