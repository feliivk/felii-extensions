import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
    name: "Nyx Scans",
    description: "Read webtoons from Nyx Scans (nyxscans.com)",
    version: "1.0.0",
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
