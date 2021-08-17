import {Connection, Event, Transport, TransportError} from 'lean-client-js-core';
import {LeanJsUrls} from './inprocesstypes';
import { Buffer } from 'buffer';
import { Stream, Writable } from 'stream';
import * as yazul from 'yauzl';
import * as path from 'path'

declare const Module: any;

export interface Library {
    /**
     * Buffer containing library.zip
     */
    zipBuffer: Buffer;
    /**
     * From library.info.json, contains a map from Lean package names to
     * URL prefixes that point to the Lean source of the olean files.
     *
     * If library.info.json could not be loaded, then this will be undefined.
     */
    urls?: {};
}

export class InProcessTransport implements Transport {
    private loadJs: () => Promise<any>;
    private memoryMB: number;
    private libraryZip: Promise<Library>;
    private loadOlean: () => Promise<any>;
    private oleanMap: any;
    private info: any;

    constructor(loadJs: () => Promise<any>, libraryZip: Promise<Library>, memoryMB: number,
                loadOlean: () => Promise<any>) {
        this.loadJs = loadJs;
        this.libraryZip = libraryZip;
        this.memoryMB = memoryMB;
        this.loadOlean = loadOlean;
    }

    connect(): Connection {
        if ((self as any).Module) {
            throw new Error('cannot use more than one instance of InProcessTransport');
        }
        (self as any).Module = {};

        Module.noExitRuntime = true;
        Module.preRun = [ () => console.log('starting lean...') ];

        const conn = new InProcessConnection();

        Module.print = (text: string) => {
            try {
                const msg = JSON.parse(text);
                // replace 'source' fields using olean_map.json if possible
                if (this.oleanMap && this.info) {
                    // info response
                    if (msg.record && msg.record.source && msg.record.source.file) {
                        msg.record.source.file = this.getUrl(msg.record.source.file);
                    } else if (msg.results && !msg.file) { // search response
                        for (let i = 0; i < msg.results.length; i++) {
                            if (msg.results[i].source && msg.results[i].source.file) {
                                msg.results[i].source.file = this.getUrl(msg.results[i].source.file);
                            }
                        }
                    } else if (msg.completions) { // completion response
                        for (let i = 0; i < msg.completions.length; i++) {
                            if (msg.completions[i].source && msg.completions[i].source.file) {
                                msg.completions[i].source.file = this.getUrl(msg.completions[i].source.file);
                            }
                        }
                    }
                }
                conn.jsonMessage.fire(msg);
            } catch (e) {
                conn.error.fire({error: 'connect', message: `cannot parse: ${text}, error: ${e}`});
            }
        };
        Module.printErr = (text: string) => conn.error.fire({error: 'stderr', chunk: text});

        Module.TOTAL_MEMORY = this.memoryMB * 1024 * 1024;

        const emscriptenInitialized = new Promise<{}>((resolve, reject) => { Module.onRuntimeInitialized = resolve; });

        console.log('downloading lean...');
        conn.module = this.init(emscriptenInitialized);
        conn.module.catch((err) =>
            conn.error.fire({
                error: 'connect',
                message: `could not start emscripten version of lean: ${err}`,
            }));

        return conn;
    }

    private getUrl(sourceFile: string): string {
        const file = sourceFile.slice(9, -5); // remove '/library/' prefix and '.lean'
        const url = this.info[this.oleanMap[file]];
        return url ? url + file + '.lean' : sourceFile;
    }

    private async init(emscriptenInitialized: Promise<{}>): Promise<typeof Module> {
        const [_loadJs, _inited, library, oleanMap]: [any, any, Library, any] = await Promise.all(
            [this.loadJs(), emscriptenInitialized, this.libraryZip, this.loadOlean()]);

        return new Promise<void>((resolve, reject) => { 
            if (library) {
                yazul.fromBuffer(library.zipBuffer, { lazyEntries: true }, (err, zipFile) => {
                    // Note that calling `zipFile.close()` is unnecessary
                    // as we are using `fromBuffer`.

                    if (err) {
                        reject(err);
                        return;
                    }
    
                    if (!zipFile) {
                        reject();
                        return;
                    }

                    this.info = library.urls;
                    zipFile.on('entry', (entry : yazul.Entry) => {
                        zipFile.openReadStream(entry, {} as yazul.ZipFileOptions, (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            try {
                                let dirname = path.dirname(entry.fileName);
                                Module.FS.createPath(Module.FS.root, path.resolve('library', dirname), true, true);
                                Module.FS.createDataFile(Module.FS.root, path.resolve('library', entry.fileName), true, true, true);
                                const writeStream = Module.FS.open(path.resolve(Module.FS.root.name, 'library', entry.fileName), 'w+');

                                readStream?.on('end', () => {
                                    zipFile.readEntry();
                                }).on('error', (err) => {
                                    reject(err);
                                })

                                readStream?.pipe(asLeanStream(writeStream));
                            } catch(err) {
                                reject(err);
                            }
                        });
                    }).on('end', () => {
                        this.oleanMap = oleanMap;
                        (Module.lean_init || Module._lean_init)();
                        console.log('lean server initialized.');
                        resolve(Module); 
                    });

                    Module.FS.createFolder(Module.FS.root, 'library', true, true);
                    zipFile.readEntry();
                });
            }
        });
    }
}

declare function lengthBytesUTF8(msg: string): number;
declare function stringToUTF8(msg: string, ptr: any, len: number) : void;

class InProcessConnection implements Connection {
    error: Event<TransportError> = new Event();
    jsonMessage: Event<any> = new Event();
    alive = true;

    module: Promise<any> | null = null;

    send(jsonMsg: any) {
        this.module?.then((mod) => {
            const msg = JSON.stringify(jsonMsg);
            const len = (lengthBytesUTF8 || mod.lengthBytesUTF8)(msg) + 1;
            const msgPtr = mod._malloc(len);
            (stringToUTF8 || mod.stringToUTF8)(msg, msgPtr, len);
            (mod.lean_process_request || mod._lean_process_request)(msgPtr);
            mod._free(msgPtr);
        });
    }

    dispose() {}
}

export function loadJsOrWasm(urls: LeanJsUrls, loadJs: (url: string) => Promise<any>): Promise<any> {
    if ((self as any).WebAssembly && urls.webassemblyJs && urls.webassemblyWasm) {
        Module.locateFile = () => urls.webassemblyWasm;
        return loadJs(urls.webassemblyJs);
    } else if (urls.javascript) {
        return loadJs(urls.javascript);
    } else {
        throw new Error(`cannot load lean.js from urls in ${urls}`);
    }
}

function loadInfoJson(infoUrl: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const req = new XMLHttpRequest();
        req.responseType = 'text';
        req.open('GET', infoUrl);
        req.onloadend = () => {
            if (req.status === 200) {
                resolve(req.responseText);
            } else {
                console.log(`could not fetch ${infoUrl}: http code ${req.status} ${req.statusText}`);
                reject(`could not fetch ${infoUrl}: http code ${req.status} ${req.statusText}`);
            }
        };
        req.onerror = (e) => {
            console.log(`error fetching ${infoUrl}`, e);
            reject(e);
        };
        req.send();
    });
}

export function loadBufferFromURL(url: string, metaUrl: string, needUrls?: boolean): Promise<Library> {
    return new Promise<Library>((resolve, reject) => {
        const req = new XMLHttpRequest();
        req.responseType = 'arraybuffer';
        req.open('GET', url);
        req.onloadend = () => {
            if (req.status === 200) {
                if (needUrls) {
                    loadInfoJson(metaUrl).then((info) =>
                        resolve({zipBuffer: Buffer.from(req.response as ArrayBuffer), urls: JSON.parse(info)}),
                        () => // infoJson could not be loaded, but we can still proceed
                        resolve({zipBuffer: Buffer.from(req.response as ArrayBuffer)}));
                } else {
                    resolve({zipBuffer: Buffer.from(req.response as ArrayBuffer)});
                }
            } else {
                reject(`could not fetch ${url}: http code ${req.status} ${req.statusText}`);
            }
        };
        req.onerror = (e) => reject(e);
        req.send();
    });
}

export function loadBufferFromURLCached(
        url: string,
        metaUrl: string,
        libKey: string | undefined,
        dbName: string,
    ): Promise<Library> | null {
    if (!url) {
        return null;
    }
    if (!url.toLowerCase().endsWith('.zip')) {
        return null;
    }
    if (!metaUrl) {
        metaUrl = url.slice(0, -3) + 'info.json';
    }
    if (!('indexedDB' in self)) {
        return loadBufferFromURL(url, metaUrl, true);
    }
    if (!libKey) {
        libKey = url.split('/').pop()?.slice(0, -4);
    }
    const infoPromise = loadInfoJson(metaUrl);

    if (!dbName) {
        dbName = 'leanlibrary';
    }
    const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const ver = 3;
        const dbRequest = indexedDB.open(dbName, ver);
        dbRequest.onsuccess = () => {
            resolve(dbRequest.result);
        };
        dbRequest.onerror = (event) => {
            console.log('failed to open indexedDB', event, dbRequest.error);
            reject(dbRequest.error);
        };
        dbRequest.onupgradeneeded = () => {
            const {result: db} = dbRequest;
            const arr = dbRequest.result.objectStoreNames;
            for (let j = 0; j < arr.length; j++) {
                db.deleteObjectStore(arr[j]);
            }
            db.createObjectStore('library');
            db.createObjectStore('meta');
        };
    });

    const metaPromise = dbPromise.then((db) => new Promise<string>((resolve, reject) => {
        if (libKey === null) {
            console.log(`libKey is empty`);
            reject();
        }

        const trans = db.transaction('meta').objectStore('meta').get(libKey as string);
        trans.onsuccess = () => {
            resolve(trans.result);
        };
        trans.onerror = (event) => {
            console.log(`error getting info.json for ${libKey} from cache`, event, trans.error);
            reject(trans.error);
        };
    }));

    return Promise.all([infoPromise, dbPromise, metaPromise])
        .then(([response, db, meta]) => {
            // TODO: better comparison between info.json and its cached version
            if (!meta || (meta !== response)) {
                // *** CACHE MISS ***
                return loadBufferFromURL(url, metaUrl).then((buff) => {
                        return new Promise<Library>((res, rej) => {
                            // save buffer to cache
                            const trans = db.transaction('library', 'readwrite').objectStore('library')
                                .put(buff.zipBuffer, libKey);
                            trans.onsuccess = () => {
                                res({zipBuffer: buff.zipBuffer, urls: JSON.parse(response)});
                            };
                            trans.onerror = (event) => {
                                console.log(`error saving ${libKey} to cache`, event, trans.error);
                                rej(trans.error);
                            };
                        });
                    // write info.json to cache after library is cached
                    }).then((buff) => new Promise<Library>((res, rej) => {
                        const trans = db.transaction('meta', 'readwrite').objectStore('meta')
                            .put(response, libKey);
                        trans.onsuccess = () => {
                            // returns library buffer, not trans.result
                            res(buff);
                        };
                        trans.onerror = (event) => {
                            console.log(`error saving info.json for ${libKey} to cache`, event, trans.error);
                            rej(trans.error);
                        };
                    }));
            }
            // *** CACHE HIT ***
            // We pretend that the meta and library stores are always in sync
            return new Promise<Library>((res, rej) => {
                if (libKey === null) {
                    console.log(`libKey is empty`);
                    rej();
                }
                const trans = db.transaction('library').objectStore('library')
                    .get(libKey as string);
                trans.onsuccess = () => {
                    res({zipBuffer: Buffer.from(trans.result), urls: JSON.parse(response)});
                };
                trans.onerror = (event) => {
                    console.log(`error getting ${libKey} from cache`, event, trans.error);
                    rej(trans.error);
                };
            });
        }).catch((reason: any) => {
            console.log(`error in caching: falling back to uncached download`, reason);
            return loadBufferFromURL(url, metaUrl, true);
        });
}

function asLeanStream(stream: any) : Writable {
    const enc = new TextEncoder();
    return new Stream.Writable({
        write(chunk, encoding, next) {
            if (encoding == 'buffer') {
                const b = chunk as Buffer;
                const uint8 = new Uint8Array(b.buffer);
                Module.FS.write(stream, uint8, b.byteOffset, b.length);
            } else {
                const b = enc.encode(chunk as string);
                Module.FS.write(stream, b, b.byteOffset, b.length);
            }
            next();
        },
        final() {
            Module.FS.close(stream);
        }
    });
}
