var config = require("config");
var sdk = require("matrix-js-sdk");
var striptags = require("striptags");
var log = require("npmlog");
var util = require("./utils");
var MessageType = require("./MessageType");
var streamifier = require("streamifier");

/**
 * Handles matrix traffic for the bot
 */
class MatrixHandler {

    /**
     * Creates a new Matrix handler and starts the bot's connection to the homeserver
     */
    constructor() {
        this._roomList = [];
        this._userId = config.get("matrix.userId");
        this._client = sdk.createClient({
            baseUrl: config.get("matrix.homeserverUrl"),
            accessToken: config.get("matrix.accessToken"),
            userId: this._userId
        });

        this._client.on('sync', function (state, prevState, data) {
            switch (state) {
                case 'PREPARED':
                    this._updateRoomList();
                    break;
            }
        }.bind(this));

        this._client.on('Room', function () {
            this._updateRoomList();
        }.bind(this));

        this._client.startClient(25); // limit number of messages to keep, we're not interesting in keeping history here
    }

    /**
     * Updates the internal list of known rooms
     * @private
     */
    _updateRoomList() {
        log.info("MatrixHandler - _updateRoomList", "Updating room list");
        var roomList = [];

        var rooms = this._client.getRooms();
        for (var room of rooms) {
            var me = room.getMember(this._userId);
            if (!me)continue;

            if (me.membership == "invite") {
                this._client.joinRoom(room.currentState.roomId);
                continue;
            }

            if (me.membership != "join")continue;
            roomList.push(room.currentState.roomId);
        }

        this._roomList = roomList;
        log.info("MatrixHandler - _updateRoomList", "Currently in " + this._roomList.length + " rooms");
    }

    /**
     * Posts an email message to the room given.
     * @param {*} message the email message to post
     * @param {String} roomId the room ID to post to
     * @param {MessageType} [messageType] the type of message (defaults to MessageType.PRIMARY)
     */
    postMessageToRoom(message, roomId, messageType) {
        if (!messageType) messageType = MessageType.PRIMARY;

        if (this._roomList.indexOf(roomId) === -1) {
            log.warn("MatrixHandler", "Attempt to send message to room " + roomId + ", but not in that room");
            return; // not in room - skip message
        }

        var config = util.getRoomConfig(roomId);
        if (!config) {
            log.error("MatrixHandler", "No configuration for room " + roomId + ", but a message was supposed to go there");
            return;
        }

        var mtxMessage = config.messageFormat;
        if (messageType != MessageType.PRIMARY) {
            mtxMessage = config[messageType.toString().toLowerCase() + "Format"];
            if (!mtxMessage) {
                log.warn("MatrixHandler", "Could not find format for message type '" + messageType.toString() + "', using fragmentFormat");
                mtxMessage = config["fragmentFormat"];
            }
        }

        for (var property in message) {
            mtxMessage = mtxMessage.replace("$" + property, message[property]);
        }

        var mtxContent = {
            body: mtxMessage,
            msgtype: "m.text"
        };

        if (!config.plaintextOnly) {
            log.info("MatrixHandler", "Preparing HTML message for room " + roomId);
            mtxContent["body"] = striptags(mtxContent.body);
            mtxContent["formatted_body"] = mtxMessage.replace(/\n/g, '<br/>'); // clients are responsible for processing the HTML
            mtxContent["format"] = "org.matrix.custom.html";
        }

        log.info("MatrixHandler", "Sending message to room " + roomId);
        this._client.sendMessage(roomId, mtxContent);
    }

    /**
     * Posts an email attachment to the room given
     * @param {{name: string, content: Buffer, type: string}} attachment the attachment to post
     * @param {String} roomId the room ID to post to
     */
    postAttachmentToRoom(attachment, roomId) {
        log.info("MatrixHandler", "Posting attachment '" + attachment.name + "' to room " + roomId);
        if (this._roomList.indexOf(roomId) === -1) {
            log.warn("MatrixHandler", "Attempt to send message to room " + roomId + ", but not in that room");
            return; // not in room - skip message
        }

        var config = util.getRoomConfig(roomId);
        if (!config) {
            log.error("MatrixHandler", "No configuration for room " + roomId + ", but a message was supposed to go there");
            return;
        }

        var eventType = "m.file";
        if (config["attachments"]["contentMapping"][attachment.type]) {
            eventType = config["attachments"]["contentMapping"][attachment.type];
        }

        log.info("MatrixHandler", "Uploading attachment '" + attachment.name + "' to room " + roomId);
        this._client.uploadContent({
            stream: streamifier.createReadStream(attachment.content),
            name: attachment.name
        }).then(url => {
            log.info("MatrixHandler", "Got MXC URL for '" + attachment.name + "': " + url);
            var content = {
                msgtype: eventType,
                body: attachment.name,
                url: JSON.parse(url).content_uri,
                info: {
                    mimetype: attachment.type
                }
            };
            log.info("MatrixHandler", "Posting attachment '" + attachment.name + "' to room " + roomId + " as event type " + eventType);
            this._client.sendMessage(roomId, content);
        });
    }
}

module.exports = MatrixHandler;