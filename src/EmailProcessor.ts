import { MatrixBot } from "./MatrixBot";
import { DataStore, IDbAttachment, IDbMessage } from "./DataStore";
import config from "./config";
import * as mailin from "@umpacken/node-mailin";
import { getRoomConfigsForTarget } from "./configUtils";
import * as replyParser from "node-email-reply-parser";
import { MessageType } from "./MessageType";

interface IEmailTarget {
    address: string;
    name: string;
    source: "to" | "cc" | "bcc";
}

export class EmailProcessor {
    public waittime = 10;
    public burstcount = 0;
    public burststart = new Date().getTime();

    public constructor(private bot: MatrixBot, private db: DataStore) {
        if (config.mail.enabled) {
            mailin.start({
                port: config.mail.port,
                logLevel: config.mail.logLevel,
                smtpOptions: {
                    banner: "",
                    disableDNSValidation: false
                }
            });

            mailin.on('message', (connection, data, content) => {
                console.log("Message Found")
                this.processMessage(data).then();
            });

            mailin.on("error", async error => {
                console.log('smtp error: ' + error);
            });
        }
    }

    public async processMessage(message: any) {
        if (await this.db.doesMessageExist(message.messageId)) {
            console.log("Message Already Processed");
            return;
        }

        const targets: IEmailTarget[] = [];

        for (const email of (message.to.value || [])) targets.push({ address: email.address.toLowerCase(), name: email.name, source: 'to' });
        for (const email of (message.cc?.value || [])) targets.push({ address: email.address.toLowerCase(), name: email.name, source: 'cc' });
        for (const email of (message.bcc?.value || [])) targets.push({ address: email.address.toLowerCase(), name: email.name, source: 'bcc' });

        const primaryFrom = message.from.value[0];

        const rooms: string[] = [];
        console.log("Processing targets...");
        for (const target of targets) {
            console.log("Processing Target ", target.address, "...");
            if (!target.address) continue;

            const roomConfigs = getRoomConfigsForTarget(target.address, target.source);
            if (!roomConfigs) continue;

            for (const roomConfig of roomConfigs) {
                if (rooms.includes(roomConfig.roomId)) {
                    continue;
                }

                if (roomConfig.antispam) {
                    if (roomConfig.antispam.maxScore > 0 && roomConfig.antispam.maxScore <= message.spamScore) {
                        continue;
                    }

                    if (roomConfig.antispam.blockFailedDkim && message.dkim !== "pass") {
                        continue;
                    }

                    if (roomConfig.antispam.blockFailedSpf && message.spf !== "pass") {
                        continue;
                    }
                }

                let allowed = true;
                if (!roomConfig.allowFromAnyone) {
                    for (const fromAddress of message.from.value) {
                        if (!fromAddress.address) continue;

                        if (!roomConfig.allowedSenders.includes(fromAddress.address.toLowerCase())) {
                            console.log(fromAddress.address, ' is not in Alllowed Senders List')
                            allowed = false;
                            break;
                        }
                    }
                }

                for (const fromAddress of message.from.value) {
                    if (!fromAddress.address) continue;

                    if (roomConfig.blockedSenders.includes(fromAddress.address.toLowerCase())) {
                        console.log(fromAddress.address, ' is in Blocked Senders List')
                        allowed = false;
                        break;
                    }
                }

                if (!allowed) continue;

                const attachments: IDbAttachment[] = [];
                if (message.attachments) {
                    const allowedTypes = (roomConfig.attachments.allowedTypes || []);
                    const blockedTypes = (roomConfig.attachments.blockedTypes || []);
                    for (const attachment of message.attachments) {
                        if (!roomConfig.attachments.allowAllTypes && !allowedTypes.includes(attachment.contentType)) {
                            continue;
                        }

                        if (blockedTypes.includes(attachment.contentType)) {
                            continue;
                        }

                        attachments.push({
                            name: attachment.generatedFileName,
                            content: attachment.content,
                            post: roomConfig.attachments.post,
                            type: attachment.contentType,
                        });
                    }
                }

                rooms.push(roomConfig.roomId);

                const contentTypeHeader = (message.headers['content-type']?.value || "text/plain").toLowerCase();
                const isHtml = contentTypeHeader.indexOf('text/plain') !== 0;
                const htmlBody = message.html;
                const textBody = message.text;
                const fullTextBody = message.text;

                let textSegments = [textBody];

                if (roomConfig.postReplies) {
                    textSegments = replyParser(textBody).getFragments().map(f => f.getContent());
                } else {
                    textSegments = [replyParser(textBody, true)];
                }

                textSegments = textSegments.filter(s => s.trim().length > 0);

                if (textSegments.length == 0 && roomConfig.postEmpty) {
                    textSegments = [""];   
                }

                const dbMessages: IDbMessage[] = [];
                for (const segment of textSegments) {
                    dbMessages.push({
                        email_id: message.messageId,
                        from_name: primaryFrom.name || "",
                        from_email: primaryFrom.address,
                        to_name: target.name || "",
                        to_email: target.address,
                        subject: message.subject,
                        text_body: segment,
                        html_body: htmlBody,
                        full_text_body: fullTextBody,
                        is_html: isHtml,
                        target_room: roomConfig.roomId,
                        date: message.date,
                    });
                }

                let msgType = MessageType.Primary;

                for (const message of dbMessages) {
                    let msg = message;
                    if (!roomConfig.skipDatabase) {
                        const messageId = await this.db.writeMessage(message);
                        await this.db.writeAttachments(attachments, messageId);
                        msg = await this.db.getMessage(messageId);
                    }

                    let messageStatus;
                    let messageRetries = 0;
                    do {
                        messageRetries = messageRetries + 1;
                        this.burstcount = this.burstcount + 1;

                        if (this.burstcount == 1) {
                            this.burststart = new Date().getTime();
                        }

                        console.log("Waiting for " + this.waittime + " Ms...");
                        await new Promise(f => setTimeout(f, this.waittime));

                        console.log('...Try #' + messageRetries + ' of Message ' + message.email_id);
                        messageStatus = await this.bot.sendMessage(msg, roomConfig.roomId, msgType);

                        if (messageStatus.retryAfterMs > this.waittime) {
                            console.log('Increasing Wait Time to ' + messageStatus.retryAfterMs)
                            this.waittime = messageStatus.retryAfterMs;
                        }

                        let elapsed = new Date().getTime() - this.burststart;
                        console.log("Burst Length: " + elapsed + " milliseconds");

                        if (elapsed > config.matrix.burst.length ) {
                            this.burstcount = 0;
                        }

                        if (this.burstcount >= config.matrix.burst.messageThreshold) {
                            console.log("Burst Message Threshold Hit at " + this.burstcount + "/" + config.matrix.burst.messageThreshold);
                            console.log("Adding " + config.matrix.burst.waitTime + " milliseconds to wait time between message tries");
                            this.waittime = this.waittime + config.matrix.burst.waitTime;
                        }

                        console.log(messageStatus.statusCode + ' ' + messageStatus.message)
                    } while (messageStatus.statusCode != 200 && messageRetries < config.matrix.messageTries);

                    if (messageStatus.statusCode == 200) {
                        this.waittime = 0;
                        console.log('Message Sent from ' + msg.from_email);
                    }
                    else {
                        console.log('Message Failed after ' + messageRetries + ' Tries');
                        console.log('From: ' + msg.from_email + ' Subject: ' + msg.subject + ' Date: ' + msg.date);
                        this.waittime = this.waittime + config.matrix.failedWaitTime
                    }                        

                    msgType = MessageType.Fragment;
                }
                for (const attachment of attachments) {
                    if (!attachment.post) continue;
                    await this.bot.sendAttachment(attachment, roomConfig.roomId);
                }
            }
        }
    }
}
