import {
    Source,
    Manga,
    Chapter,
    ChapterDetails,
    HomeSection,
    SearchRequest,
    PagedResults,
    SourceInfo,
    ContentRating,
    Request,
    Response,
    SourceIntents,
    HomeSectionType,
    MangaTile,
    Tag
} from '@paperback/types';

// URLs Base
const API_URL = "https://manhwawebbackend-production.up.railway.app";
const WEB_URL = "https://manhwaweb.com";

// Constantes reutilizables
const FALLBACK_COVER = "https://placehold.co/400x600?text=No+Cover";
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const SEE_CACHE_TTL = 60_000; // 1 min
const SEE_CACHE_MAX = 50;

export const ManhwaWebInfo: SourceInfo = {
    version: '1.2.1',
    name: 'ManhwaWeb',
    icon: 'icon.png',
    author: 'Felii',
    authorWebsite: 'https://github.com/feliivk',
    description: 'Lectura directa desde ManhwaWeb con API rápida',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: WEB_URL,
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS
};

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

// Item genérico de listados (biblioteca / home). Los campos varían por endpoint.
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
}

export class ManhwaWeb extends Source {

    requestManager = createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    "Origin": WEB_URL,
                    "Referer": `${WEB_URL}/`,
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json, text/plain, */*",
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                    "Expires": "0",
                    "If-None-Match": "" // Bust ETag cache
                };
                return request;
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response;
            },
        },
    });

    // Caché del endpoint /manhwa/see/{id}, compartido por getMangaDetails y getChapters
    private seeCache = new Map<string, { data: SeeResponse; expiry: number }>();

    // --- Helpers ---

    // Petición GET + validación de status + parseo JSON (centraliza el manejo de errores)
    private async fetchJson<T = any>(url: string): Promise<T> {
        const request = createRequestObject({ url, method: "GET" });
        const response = await this.requestManager.schedule(request, 1);

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`La petición falló (${response.status}): ${url}`);
        }
        try {
            return JSON.parse(response.data) as T;
        } catch (e) {
            throw new Error(`Error al parsear JSON de ${url}: ${e}`);
        }
    }

    // Obtiene el detalle de una obra con caché (evita dos llamadas al abrir un manga)
    private async getSee(mangaId: string): Promise<SeeResponse> {
        const now = Date.now();
        const cached = this.seeCache.get(mangaId);
        if (cached && cached.expiry > now) return cached.data;

        const data = await this.fetchJson<SeeResponse>(`${API_URL}/manhwa/see/${mangaId}`);

        if (this.seeCache.size >= SEE_CACHE_MAX) this.seeCache.clear();
        this.seeCache.set(mangaId, { data, expiry: now + SEE_CACHE_TTL });
        return data;
    }

    private getIdFromItem(item: ListItem): string {
        return item.real_id || item._id || item.id_manhwa || (item.link ? item.link.split('/').filter(Boolean).pop() ?? "" : "") || "";
    }

    private pickTitle(item: ListItem): string {
        return item.the_real_name || item.name_esp || item._name || item.name || item.name_manhwa || "Sin título";
    }

    private pickImage(item: ListItem): string {
        return item._imagen || item.imagen || item.img || FALLBACK_COVER;
    }

    private buildTile(id: string, item: ListItem): MangaTile {
        return createMangaTile({
            id,
            title: createIconText({ text: this.pickTitle(item) }),
            image: this.pickImage(item)
        });
    }

    // Mapea el estado textual de la API al enum numérico de Paperback
    private mapStatus(statusText?: string): number {
        const s = (statusText || "").toLowerCase();
        if (s.includes("finalizado")) return 1; // COMPLETED
        if (s.includes("pausado")) return 2;     // HIATUS
        return 0;                                // ONGOING
    }

    // 1. Detalles del manga
    async getMangaDetails(mangaId: string): Promise<Manga> {
        const data = await this.getSee(mangaId);

        const title = this.pickTitle(data);
        const image = data._imagen || FALLBACK_COVER;
        const desc = data._sinopsis || "Sin descripción disponible.";
        const author = data._extras?.autores?.join(', ') || "Desconocido";

        const tags: Tag[] = [];
        if (Array.isArray(data._categoris)) {
            for (const cat of data._categoris) {
                const key = Object.keys(cat)[0];
                if (key) tags.push(createTag({ id: key, label: cat[key] ?? key, type: 'blue' }));
            }
        }
        if (data._demografi) tags.push(createTag({ id: data._demografi, label: data._demografi.toUpperCase(), type: 'green' }));
        if (data._tipo) tags.push(createTag({ id: data._tipo, label: data._tipo.toUpperCase(), type: 'yellow' }));

        return createManga({
            id: mangaId,
            titles: [title],
            image: image,
            rating: 0,
            status: this.mapStatus(data._status),
            author: author,
            desc: desc,
            hentai: data._erotico === "si",
            lastUpdate: data._creation ? new Date(data._creation) : new Date(),
            tags: [createTagSection({ id: '0', label: 'Géneros', tags })]
        });
    }

    // 2. Capítulos
    async getChapters(mangaId: string): Promise<Chapter[]> {
        const data = await this.getSee(mangaId);
        const rawChapters = data.chapters ?? [];
        const chapters: Chapter[] = [];

        for (const ch of rawChapters) {
            let chId = "";
            const link = ch.link ?? ch.versions?.find((v) => v.link)?.link;
            if (link) {
                chId = link.split('/').filter(Boolean).pop() ?? "";
            }
            if (!chId) chId = `${mangaId}-${ch.chapter}_01`;
            const created = ch.create ?? ch.versions?.[0]?.create;

            chapters.push(createChapter({
                id: chId,
                mangaId: mangaId,
                name: `Capítulo ${ch.chapter}`,
                chapNum: parseFloat(String(ch.chapter)) || 0, // Soporta decimales (ej. 51.2)
                time: created ? new Date(created) : new Date(),
                langCode: "es",
            }));
        }

        // Más reciente primero
        return chapters.reverse();
    }

    // 3. Páginas del capítulo
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const data = await this.fetchJson<{ chapter?: { img?: string[] } }>(`${API_URL}/chapters/see/${chapterId}`);
        const pages = Array.isArray(data.chapter?.img) ? data.chapter!.img! : [];

        return createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages,
        });
    }

    // 4. Búsqueda
    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const page = metadata?.page ?? 0;
        const term = encodeURIComponent(query.title ?? "");
        const url = `${API_URL}/manhwa/library?buscar=${term}&estado=&tipo=&erotico=&demografia=&order_item=alfabetico&order_dir=desc&page=${page}&generes=`;

        const data = await this.fetchJson<{ data?: ListItem[]; next?: boolean }>(url);
        const results = data.data ?? [];

        const tiles = results.map((item) => this.buildTile(this.getIdFromItem(item), item));

        return createPagedResults({
            results: tiles,
            metadata: data.next ? { page: page + 1 } : undefined
        });
    }

    // 5. Secciones de la página principal (/manhwa/nuevos)
    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const data = await this.fetchJson<{
            utimos_mangas_creados?: ListItem[];
            top?: { manhwas_esp?: ListItem[] };
            manhwas?: { manhwas_esp?: ListItem[] };
        }>(`${API_URL}/manhwa/nuevos`);

        // Nuevas Obras
        const newSection = createHomeSection({
            id: 'new_works',
            title: 'Nuevas Obras',
            type: HomeSectionType.singleRowNormal,
            view_more: false
        });
        sectionCallback(newSection);
        newSection.items = (data.utimos_mangas_creados ?? []).map((item) => this.buildTile(this.getIdFromItem(item), item));
        sectionCallback(newSection);

        // Lo más leído
        const popularSection = createHomeSection({
            id: 'popular',
            title: 'Lo más leído',
            type: HomeSectionType.singleRowLarge,
            view_more: false
        });
        sectionCallback(popularSection);
        popularSection.items = (data.top?.manhwas_esp ?? []).map((item) => this.buildTile(this.getIdFromItem(item), item));
        sectionCallback(popularSection);

        // Nuevos Capítulos (deduplicado por manga)
        const latestSection = createHomeSection({
            id: 'latest_updates',
            title: 'Nuevos Capítulos',
            type: HomeSectionType.singleRowNormal,
            view_more: false
        });
        sectionCallback(latestSection);
        const seen = new Set<string>();
        latestSection.items = (data.manhwas?.manhwas_esp ?? [])
            .filter((item) => {
                const id = item.id_manhwa || '';
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
            })
            .map((item) => this.buildTile(item.id_manhwa || '', item));
        sectionCallback(latestSection);
    }
}
