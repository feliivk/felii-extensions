import {
    BasicRateLimiter,
    Chapter,
    ChapterDetails,
    ChapterProviding,
    ContentRating,
    DiscoverSection,
    DiscoverSectionItem,
    DiscoverSectionProviding,
    DiscoverSectionType,
    Extension,
    Form,
    MangaProviding,
    Metadata,
    PagedResults,
    PaperbackInterceptor,
    Request,
    Response,
    SearchQuery,
    SearchResultItem,
    SearchResultsProviding,
    Section,
    SettingsFormProviding,
    SourceManga,
    Tag,
    TagSection,
    ToggleRow,
} from "@paperback/types";

// URLs base
const API_URL = "https://manhwawebbackend-production.up.railway.app";
const WEB_URL = "https://manhwaweb.com";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

const SEE_CACHE_TTL = 60_000;
const SEE_CACHE_MAX = 50;

// --- Tipos de la API ---
interface ApiChapter {
    link?: string;
    chapter?: string | number;
    create?: string | number;
    // Los capítulos recién subidos solo traen link/create aquí dentro
    versions?: { link?: string; create?: string | number }[];
}

interface SeeResponse {
    the_real_name?: string;
    name_esp?: string;
    _name?: string;
    _imagen?: string;
    _sinopsis?: string;
    _status?: string;
    _extras?: { autores?: string[] };
    _categoris?: Array<Record<string, string>>;
    _demografi?: string;
    _tipo?: string;
    _erotico?: string;
    _creation?: string;
    chapters?: ApiChapter[];
}

interface ListItem {
    real_id?: string;
    _id?: string;
    id_manhwa?: string;
    link?: string;
    the_real_name?: string;
    name_esp?: string;
    _name?: string;
    name?: string;
    name_manhwa?: string;
    _imagen?: string;
    imagen?: string;
    img?: string;
    _erotico?: string;
}

// --- Ajuste NSFW (+18) ---
// Por defecto respeta el filtro de contenido adulto del perfil de la app;
// el usuario puede sobreescribirlo desde los ajustes de la extensión.
const NSFW_STATE_KEY = "manhwaweb.showNsfw";

function getShowNsfw(): boolean {
    const v = Application.getState(NSFW_STATE_KEY);
    if (typeof v === "boolean") return v;
    try {
        return typeof Application.filterAdultTitles === "boolean" ? !Application.filterAdultTitles : true;
    } catch {
        return true;
    }
}

class ManhwaWebSettingsForm extends Form {
    private showNsfw = getShowNsfw();

    async updateShowNsfw(value: boolean): Promise<void> {
        this.showNsfw = value;
        Application.setState(value, NSFW_STATE_KEY);
        this.reloadForm();
    }

    override getSections() {
        return [
            Section(
                {
                    id: "contenido",
                    footer:
                        "Aplica a la búsqueda y a Nuevas Obras. Las secciones Lo más leído y " +
                        "Nuevos Capítulos no incluyen el dato +18 en la API y no se filtran.",
                },
                [
                    ToggleRow("show_nsfw", {
                        title: "Mostrar contenido +18 (NSFW)",
                        value: this.showNsfw,
                        onValueChange: Application.Selector<
                            ManhwaWebSettingsForm,
                            (value: boolean) => Promise<void>
                        >(this, "updateShowNsfw"),
                    }),
                ],
            ),
        ];
    }
}

class ManhwaWebInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            origin: WEB_URL,
            referer: `${WEB_URL}/`,
            "user-agent": await Application.getDefaultUserAgent(),
            accept: "application/json, text/plain, */*",
            "cache-control": "no-cache",
        };
        return request;
    }

    override async interceptResponse(
        _request: Request,
        _response: Response,
        data: ArrayBuffer,
    ): Promise<ArrayBuffer> {
        return data;
    }
}

type ManhwaWebImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding &
    SettingsFormProviding;

export class ManhwaWebExtension implements ManhwaWebImplementation {
    requestManager = new ManhwaWebInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 3,
        bufferInterval: 1,
        ignoreImages: true,
    });

    private seeCache = new Map<string, { data: SeeResponse; expiry: number }>();

    async initialise(): Promise<void> {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }

    async getSettingsForm(): Promise<Form> {
        return new ManhwaWebSettingsForm();
    }

    // ---- fetch helpers ----

    private async fetchJson<T = any>(url: string): Promise<T> {
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`La petición falló (${response.status}): ${url}`);
        }
        return JSON.parse(Application.arrayBufferToUTF8String(data)) as T;
    }

    private async getSee(mangaId: string): Promise<SeeResponse> {
        const now = Date.now();
        const cached = this.seeCache.get(mangaId);
        if (cached && cached.expiry > now) return cached.data;

        const data = await this.fetchJson<SeeResponse>(`${API_URL}/manhwa/see/${mangaId}`);
        if (this.seeCache.size >= SEE_CACHE_MAX) this.seeCache.clear();
        this.seeCache.set(mangaId, { data, expiry: now + SEE_CACHE_TTL });
        return data;
    }

    // ---- utils ----

    // Los IDs en 0.9 solo admiten alfanuméricos y `._-@()[]%?#+=/&:`. Algunos slugs
    // traen `¡`/`!` (¡me_canse_..._multimillonario!_...) → se percent-encodean. El
    // backend acepta el slug encodeado en la URL, así que no hace falta decodificar.
    private toSafeId(id: string): string {
        return id.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
            const enc = encodeURIComponent(c);
            if (enc !== c) return enc;
            return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
    }

    private getIdFromItem(item: ListItem): string {
        return this.toSafeId(
            item.real_id ||
                item._id ||
                item.id_manhwa ||
                (item.link ? item.link.split("/").filter(Boolean).pop() ?? "" : "") ||
                "",
        );
    }

    private pickTitle(item: ListItem): string {
        return item.the_real_name || item.name_esp || item._name || item.name || item.name_manhwa || "Sin título";
    }

    private pickImage(item: ListItem): string {
        return item._imagen || item.imagen || item.img || FALLBACK_COVER;
    }

    // Sin contentRating explícito la app trata el ítem como "Unknown" y difumina
    // la portada con una "U"; se declara siempre (ADULT si la API lo marca +18).
    private ratingFromItem(item: ListItem): ContentRating {
        return item._erotico === "si" ? ContentRating.ADULT : ContentRating.MATURE;
    }

    private searchItemFromItem(item: ListItem): SearchResultItem {
        return {
            mangaId: this.getIdFromItem(item),
            title: this.pickTitle(item),
            imageUrl: this.pickImage(item),
            contentRating: this.ratingFromItem(item),
        };
    }

    private discoverItemFromItem(item: ListItem, id: string, featured: boolean): DiscoverSectionItem {
        const base = {
            mangaId: id,
            imageUrl: this.pickImage(item),
            title: this.pickTitle(item),
            contentRating: this.ratingFromItem(item),
        };
        return featured
            ? { type: "featuredCarouselItem", ...base }
            : { type: "simpleCarouselItem", ...base };
    }

    private mapStatus(statusText?: string): string {
        const s = (statusText || "").toLowerCase();
        if (s.includes("finalizado")) return "Completed";
        if (s.includes("pausado")) return "Hiatus";
        return "Ongoing";
    }

    // ---- manga details ----

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const data = await this.getSee(mangaId);

        const title = this.pickTitle(data);
        const image = data._imagen || FALLBACK_COVER;
        const synopsis = data._sinopsis || "Sin descripción disponible.";
        const author = data._extras?.autores?.join(", ") || undefined;

        const tags: Tag[] = [];
        if (Array.isArray(data._categoris)) {
            for (const cat of data._categoris) {
                const key = Object.keys(cat)[0];
                if (key) tags.push({ id: key, title: cat[key] ?? key });
            }
        }
        if (data._demografi) tags.push({ id: data._demografi, title: data._demografi.toUpperCase() });
        if (data._tipo) tags.push({ id: data._tipo, title: data._tipo.toUpperCase() });

        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "genres", title: "Géneros", tags });

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: image,
                synopsis,
                contentRating: data._erotico === "si" ? ContentRating.ADULT : ContentRating.MATURE,
                status: this.mapStatus(data._status),
                author,
                tagGroups,
                shareUrl: `${WEB_URL}/manhwa/${mangaId}`,
            },
        };
    }

    // ---- chapters ----

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const data = await this.getSee(sourceManga.mangaId);
        const rawChapters = data.chapters ?? [];
        const chapters: Chapter[] = [];

        for (const ch of rawChapters) {
            let chId = "";
            // El slug del capítulo incluye el del manga → puede traer `¡`/`!` también
            const link = ch.link ?? ch.versions?.find((v) => v.link)?.link;
            if (link) chId = this.toSafeId(link.split("/").filter(Boolean).pop() ?? "");
            if (!chId) chId = `${sourceManga.mangaId}-${ch.chapter}_01`;
            const created = ch.create ?? ch.versions?.[0]?.create;

            chapters.push({
                chapterId: chId,
                sourceManga,
                title: `Capítulo ${ch.chapter}`,
                chapNum: parseFloat(String(ch.chapter)) || 0,
                publishDate: created ? new Date(created) : undefined,
                langCode: "es",
            });
        }

        return chapters.reverse();
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const data = await this.fetchJson<{ chapter?: { img?: string[] } }>(
            `${API_URL}/chapters/see/${chapter.chapterId}`,
        );
        const raw = Array.isArray(data.chapter?.img) ? data.chapter!.img! : [];
        // Solo URLs https: descarta cualquier esquema raro que traiga la API
        const pages = raw.filter((p) => typeof p === "string" && p.startsWith("https://"));

        return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
    }

    // ---- search ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = (metadata as { page?: number } | undefined)?.page ?? 0;
        const term = encodeURIComponent(query.title ?? "");
        // erotico: "" = todo, "no" = sin contenido +18 (según el ajuste de la extensión)
        const erotico = getShowNsfw() ? "" : "no";
        const url = `${API_URL}/manhwa/library?buscar=${term}&estado=&tipo=&erotico=${erotico}&demografia=&order_item=alfabetico&order_dir=desc&page=${page}&generes=`;

        const data = await this.fetchJson<{ data?: ListItem[]; next?: boolean }>(url);
        const results = data.data ?? [];
        const items = results.map((item) => this.searchItemFromItem(item));

        return { items, metadata: data.next ? { page: page + 1 } : undefined };
    }

    // ---- discover ----

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: "new_works", title: "Nuevas Obras", type: DiscoverSectionType.simpleCarousel },
            { id: "popular", title: "Lo más leído", type: DiscoverSectionType.featured },
            { id: "latest_updates", title: "Nuevos Capítulos", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const data = await this.fetchJson<{
            utimos_mangas_creados?: ListItem[];
            top?: { manhwas_esp?: ListItem[] };
            manhwas?: { manhwas_esp?: ListItem[] };
        }>(`${API_URL}/manhwa/nuevos`);

        const featured = section.type === DiscoverSectionType.featured;
        let items: DiscoverSectionItem[] = [];

        if (section.id === "new_works") {
            // Única sección de /nuevos cuyos items traen _erotico → filtrable
            const showNsfw = getShowNsfw();
            items = (data.utimos_mangas_creados ?? [])
                .filter((item) => showNsfw || item._erotico !== "si")
                .map((item) => this.discoverItemFromItem(item, this.getIdFromItem(item), featured));
        } else if (section.id === "popular") {
            items = (data.top?.manhwas_esp ?? []).map((item) =>
                this.discoverItemFromItem(item, this.getIdFromItem(item), featured),
            );
        } else if (section.id === "latest_updates") {
            const seen = new Set<string>();
            items = (data.manhwas?.manhwas_esp ?? [])
                .filter((item) => {
                    const id = item.id_manhwa || "";
                    if (!id || seen.has(id)) return false;
                    seen.add(id);
                    return true;
                })
                .map((item) => this.discoverItemFromItem(item, this.toSafeId(item.id_manhwa || ""), featured));
        }

        return { items, metadata: undefined };
    }
}

export const ManhwaWeb = new ManhwaWebExtension();
