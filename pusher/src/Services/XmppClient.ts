import { ExSocketInterface } from "../Model/Websocket/ExSocketInterface";
import { v4 } from "uuid";
import {
    MucRoomDefinitionMessage,
    PusherToIframeMessage,
    XmppConnectionNotAuthorizedMessage,
    XmppConnectionStatusChangeMessage,
    XmppMessage,
    XmppSettingsMessage,
} from "../Messages/generated/messages_pb";
import { MucRoomDefinitionInterface } from "../Messages/JsonMessages/MucRoomDefinitionInterface";
import { EJABBERD_DOMAIN, EJABBERD_WS_URI } from "../Enum/EnvironmentVariable";
import CancelablePromise from "cancelable-promise";
import jid, { JID } from "@xmpp/jid";
import { Client, client, xml } from "@xmpp/client";
import { Element } from "@xmpp/xml";
import SASLError from "@xmpp/sasl/lib/SASLError";
import StreamError from "@xmpp/connection/lib/StreamError";

class ElementExt extends Element {}

//eslint-disable-next-line @typescript-eslint/no-var-requires
const parse = require("@xmpp/xml/lib/parse");
export class XmppClient {
    private address!: JID;
    private clientPromise!: CancelablePromise<Client>;
    private clientJID: JID;
    private clientID: string;
    private clientDomain: string;
    private clientResource: string;
    private clientPassword: string;
    private timeout: ReturnType<typeof setTimeout> | undefined;
    private xmppSocket: Client | undefined;
    private isAuthorized = true;

    constructor(private clientSocket: ExSocketInterface, private initialMucRooms: MucRoomDefinitionInterface[]) {
        this.clientJID = jid(clientSocket.jabberId);
        this.clientID = this.clientJID.local;
        this.clientDomain = this.clientJID.domain;
        this.clientResource = this.clientJID.resource;
        this.clientPassword = clientSocket.jabberPassword;
        this.start();
    }

    // FIXME: complete a scenario where ejabberd is STOPPED when a user enters the room and then started

    private createClient(res: (value: Client | PromiseLike<Client>) => void, rej: (reason?: unknown) => void): void {
        if (!this.isAuthorized) return;
        try {
            let status: "disconnected" | "connected" = "disconnected";
            const xmpp = client({
                service: `${EJABBERD_WS_URI}`,
                domain: EJABBERD_DOMAIN,
                username: this.clientID,
                resource: this.clientResource ? this.clientResource : v4().toString(), //"pusher",
                password: this.clientPassword,
            });
            this.xmppSocket = xmpp;

            xmpp.on("error", (err: unknown) => {
                if (err instanceof SASLError)
                    console.info("XmppClient => createClient => receive => error", err.name, err.condition);
                else {
                    console.info("XmppClient => createClient => receive => error", err);
                }
                //console.error("XmppClient => receive => error =>", err);
                this.xmppSocket?.stop();
            });

            xmpp.reconnect.on("reconnecting", () => {
                console.info("XmppClient => createClient => reconnecting");
            });

            xmpp.reconnect.on("reconnected", () => {
                console.info("XmppClient => createClient => reconnected");
            });

            xmpp.on("offline", () => {
                console.info("XmppClient => createClient => offline => status", status);
                status = "disconnected";

                //close en restart connexion
                this.close();

                // This can happen when the first connection failed for some reason.
                // We should probably retry regularly (every 10 seconds)
                if (this.timeout) {
                    clearTimeout(this.timeout);
                    this.timeout = undefined;
                }
                if (this.isAuthorized) {
                    this.timeout = setTimeout(() => {
                        this.start();
                    }, 10_000);
                }
            });

            xmpp.on("disconnect", () => {
                console.info(
                    "XmppClient => createClient => disconnect => status",
                    status,
                    this.clientSocket.disconnecting
                );
                if (status !== "disconnected") {
                    status = "disconnected";

                    const xmppConnectionStatusChangeMessage = new XmppConnectionStatusChangeMessage();
                    xmppConnectionStatusChangeMessage.setStatus(XmppConnectionStatusChangeMessage.Status.DISCONNECTED);

                    const pusherToIframeMessage = new PusherToIframeMessage();
                    pusherToIframeMessage.setXmppconnectionstatuschangemessage(xmppConnectionStatusChangeMessage);

                    if (!this.clientSocket.disconnecting) {
                        this.clientSocket.send(pusherToIframeMessage.serializeBinary().buffer, true);
                    }
                }
            });
            xmpp.on("online", (address: JID) => {
                console.info("XmppClient => createClient => online");
                xmpp.reconnect.stop();
                status = "connected";
                //TODO
                // define if MUC must persistent or not
                // if persistent, send subscribe MUC
                // Admin can create presence and subscribe MUC with members
                this.address = address;
                const xmppSettings = new XmppSettingsMessage();
                xmppSettings.setJid(address.toString());
                xmppSettings.setConferencedomain("conference.ejabberd");
                xmppSettings.setRoomsList(
                    this.initialMucRooms.map((definition: MucRoomDefinitionInterface) => {
                        const mucRoomDefinitionMessage = new MucRoomDefinitionMessage();
                        if (!definition.name || !definition.url || !definition.type) {
                            throw new Error("Name URL and type cannot be empty!");
                        }
                        mucRoomDefinitionMessage.setName(definition.name);
                        mucRoomDefinitionMessage.setUrl(definition.url);
                        mucRoomDefinitionMessage.setType(definition.type);
                        mucRoomDefinitionMessage.setSubscribe(definition.subscribe);
                        return mucRoomDefinitionMessage;
                    })
                );

                const pusherToIframeMessage = new PusherToIframeMessage();
                pusherToIframeMessage.setXmppsettingsmessage(xmppSettings);

                if (!this.clientSocket.disconnecting) {
                    this.clientSocket.send(pusherToIframeMessage.serializeBinary().buffer, true);
                }
            });
            xmpp.on("status", (status: string) => {
                console.error("XmppClient => createClient => status => status", status);
                // FIXME: the client keeps trying to reconnect.... even if the pusher is disconnected!
            });

            xmpp.start()
                .then(() => {
                    console.log("XmppClient => createClient => start");
                    res(xmpp);
                })
                .catch((err: Error) => {
                    //throw err;
                    if (err instanceof SASLError || err instanceof StreamError) {
                        this.isAuthorized = err.condition !== "not-authorized";
                        if (!this.isAuthorized) {
                            const pusherToIframeMessage = new PusherToIframeMessage();
                            pusherToIframeMessage.setXmppconnectionnotauthorized(
                                new XmppConnectionNotAuthorizedMessage()
                            );

                            if (!this.clientSocket.disconnecting) {
                                this.clientSocket.send(pusherToIframeMessage.serializeBinary().buffer, true);
                            }
                        }
                    }
                    rej(err);
                });

            xmpp.on("stanza", (stanza: unknown) => {
                // @ts-ignore
                const stanzaString = stanza.toString();
                const elementExtParsed = parse(stanzaString) as ElementExt;

                //parse for ping XMPP message and send pong
                if (elementExtParsed.getChild("ping")) {
                    this.sendPong(
                        elementExtParsed.getAttr("from"),
                        elementExtParsed.getAttr("to"),
                        elementExtParsed.getAttr("id")
                    );
                    return;
                }

                const xmppMessage = new XmppMessage();
                xmppMessage.setStanza(stanzaString);

                const pusherToIframeMessage = new PusherToIframeMessage();
                pusherToIframeMessage.setXmppmessage(xmppMessage);

                if (!this.clientSocket.disconnecting) {
                    this.clientSocket.send(pusherToIframeMessage.serializeBinary().buffer, true);
                }
            });
        } catch (err) {
            console.error("XmppClient => createClient => Error", err);
            rej(err);
        }
    }

    /*sendMessage() {
        return this.clientPromise.then((xmpp) => {
            const message = xml("message", { type: "chat", to: this.address }, xml("body", {}, "hello world"));
            return xmpp.send(message);
        });
    }

    getRoster() {
        return this.clientPromise.then((xmpp) => {
            const from = "admin@" + this.address._domain + "/" + this.address._resource;
            const message = xml("iq", { type: "get", from: from }, xml("query", { xmlns: "jabber:iq:roster" }));
            console.log("my message", message);
            return xmpp.send(message);
        });
    }*/

    close(): void {
        //cancel promise
        console.info("xmppClient => close");
        this.clientPromise.cancel();
    }

    start(): CancelablePromise {
        console.info("xmppClient => start");
        return (this.clientPromise = new CancelablePromise((res, rej, onCancel) => {
            this.createClient(res, rej);
            onCancel(() => {
                (async (): Promise<void> => {
                    console.info("clientPromise => onCancel => from xmppClient");
                    if (this.timeout) {
                        clearTimeout(this.timeout);
                        this.timeout = undefined;
                    }

                    //send present unavailable
                    try {
                        if (this.xmppSocket?.status === "online") {
                            await this.xmppSocket?.send(xml("presence", { type: "unavailable" }));
                        }
                    } catch (err) {
                        console.info("XmppClient => onCancel => presence => err", err);
                    }
                    try {
                        //stop xmpp socket client
                        await this.xmppSocket?.close();
                    } catch (errClose) {
                        console.info("XmppClient => onCancel => xmppSocket => errClose", errClose);
                        try {
                            //stop xmpp socket client
                            await this.xmppSocket?.stop();
                        } catch (errStop) {
                            console.info("XmppClient => onCancel => xmppSocket => errStop", errStop);
                        }
                    }
                })();
            });
        }).catch((err) => {
            if (err instanceof SASLError) {
                console.info("clientPromise => receive => error", err.name, err.condition);
            } else {
                console.info("clientPromise => receive => error", err);
            }
            this.clientPromise.cancel();
        }));
    }

    async sendPong(to: string, from: string, id: string): Promise<void> {
        await this.send(xml("iq", { from, to, id, type: "result" }).toString());
        return;
    }

    async send(stanza: string): Promise<void> {
        const ctx = parse(stanza);
        await this.xmppSocket?.send(ctx);
        return;
    }
}