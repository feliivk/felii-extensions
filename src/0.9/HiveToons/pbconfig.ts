import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
    name: "HiveToons",
    description: "Read webtoons from HiveToons (hivetoons.org)",
    version: "1.2.0",
    icon: "icon.png",
    language: "en",
    contentRating: ContentRating.MATURE,
    capabilities: [
        SourceIntents.DISCOVER_SECTION_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.CHAPTER_PROVIDING,
        SourceIntents.SETTINGS_FORM_PROVIDING,
    ],
    badges: [{ label: "Webtoon", textColor: "#ffffff", backgroundColor: "#e11d48" }],
    developers: [{ name: "Felii", github: "https://github.com/feliivk" }],
} satisfies ExtensionInfo;
