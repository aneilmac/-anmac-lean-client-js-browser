import {Connection} from 'lean-client-js-core';
import {InProcessTransport, loadBufferFromURLCached, loadJsOrWasm} from './inprocess';
import {ErrorRes, Req, StartWorkerReq} from './webworkertypes';
// could also get types from 'webworker' in tsconfig
declare function importScripts(...urls: string[]): void;
declare function postMessage(message: any, transfer?: any[]): void;

let conn: Connection | null = null;

onmessage = (e: MessageEvent<any>) => {
    const req = e.data as Req;
    switch (req.command) {
        case 'start-webworker': {
            const opts = (req as StartWorkerReq).opts;

            const loadJs = (url: string) => new Promise<void>((resolve) => { importScripts(url); resolve(); });
            const loadOleanMap = (url: string) => fetch(url).then((res) => res.ok && res.json());
            const oleanMapUrl = opts.libraryOleanMap || (opts.libraryZip.slice(0, -3) + 'olean_map.json');

            const buffer = loadBufferFromURLCached(opts.libraryZip, 
                opts.libraryMeta as string, 
                opts.libraryKey as string, 
                opts.dbName as string);

            if (buffer)
            {
                conn = new InProcessTransport(
                    () => loadJsOrWasm(opts, loadJs),
                    buffer,
                    opts.memoryMB || 256,
                    () => loadOleanMap(oleanMapUrl)
                ).connect();
                
                conn.jsonMessage.on((msg: any) => postMessage(msg));
                conn.error.on((error: any) => postMessage({response: 'webworker-error', error} as ErrorRes));
            }
            break;
        }
        default:
            if (conn !== null) {
                conn.send(req);
            }
    }
};

export default null as any;
