import {Connection, Event, Transport, TransportError} from 'lean-client-js-core';
import {LeanJsOpts} from './inprocesstypes';
import {Res, StartWorkerReq} from './webworkertypes';

export class WebWorkerTransport implements Transport {
    opts: LeanJsOpts;

    constructor(opts: LeanJsOpts) {
        this.opts = opts;
    }

    connect(): WebWorkerConnection {
        const worker = new Worker(
            new URL('./webworkerscript.ts', import.meta.url), 
            { type: 'module',
              credentials: 'same-origin'
            }
        );
        worker.postMessage({
            command: 'start-webworker',
            opts: this.opts,
        } as StartWorkerReq);
        const conn = new WebWorkerConnection(worker);
        worker.onmessage = (e) => {
            const res = e.data as Res;
            // Pass all messages (including errors) back to the server object
            // jsonMessage has some error handling already
            conn.jsonMessage.fire(res);
        };
        return conn;
    }
}

export class WebWorkerConnection implements Connection {
    // TODO: type issue here; not all errors are TransportErrors
    // try e.g. server.info() with a missing file
    error: Event<TransportError> = new Event();
    jsonMessage: Event<any> = new Event();
    alive = true;

    worker: Worker;

    constructor(worker: Worker) {
        this.worker = worker;
    }

    send(msg: any) : void {
        this.worker.postMessage(msg);
    }

    dispose() : void {
        this.worker.terminate();
        this.alive = false;
    }
}
