//
//  Created by Mingliang Chen on 17/8/4.
//  illuspas[a]gmail.com
//  Copyright (c) 2017 Nodemedia. All rights reserved.
//
const Logger = require('./logger');

const EventEmitter = require('events');
const URL = require('url');

const AMF = require('./node_core_amf');
const BufferPool = require('./node_core_bufferpool');
const NodeCoreUtils = require('./node_core_utils');

const context = require('./node_core_ctx');

class NodeFlvSession extends EventEmitter {
  constructor(config, req, res) {
    super();
    this.config = config;
    this.id = NodeCoreUtils.generateNewSessionID();
    this.req = req;
    this.res = res;
    this.bp = new BufferPool(this.handleData());
    this.allow_origin = config.http.allow_origin == undefined ? '*' : config.http.allow_origin;
    this.isPublisher = false;
    this.playStreamPath = '';
    this.playArgs = null;

    this.on('connect', this.onConnect);
    this.on('play', this.onPlay);
    this.on('publish', this.onPublish);

    if (req.nmsConnectionType === 'ws') {
      this.res.on('message', this.onReqData.bind(this));
      this.res.on('close', this.onReqClose.bind(this));
      this.res.on('error', this.onReqError.bind(this));
      this.res.write = this.res.send;
      this.res.end = this.res.close;
      this.TAG = 'websocket-flv'
    } else {
      this.req.on('data', this.onReqData.bind(this));
      this.req.socket.on('close', this.onReqClose.bind(this));
      this.req.on('error', this.onReqError.bind(this));
      this.TAG = 'http-flv'
    }

    context.sessions.set(this.id, this);
  }

  run() {
    let method = this.req.method;
    let urlInfo = URL.parse(this.req.url, true);
    let streamPath = urlInfo.pathname.split('.')[0];
    let format = urlInfo.pathname.split('.')[1];
    this.connectCmdObj = { method, streamPath, query: urlInfo.query };
    context.nodeEvent.emit('preConnect', this.id, this.connectCmdObj);

    this.isStarting = true;
    this.bp.init();

    this.connectTime = new Date();

    if (format != 'flv') {
      Logger.error(`[${this.TAG}] Unsupported format=${format}`);
      this.res.statusCode = 403;
      this.res.end();
      return;
    }
    context.nodeEvent.emit('postConnect', this.id, this.connectCmdObj);
    if (method == 'GET') {
      //Play 
      this.playStreamPath = streamPath;
      this.playArgs = urlInfo.query;
      Logger.log(`[${this.TAG} play] play stream ` + this.playStreamPath);
      this.emit('play');

    } else if (method == 'POST') {
      //Publish

      Logger.error(`[${this.TAG}] Unsupported method=` + method);
      this.res.statusCode = 405;
      this.res.end();
      return;
    } else {
      Logger.error(`[${this.TAG}] Unsupported method=` + method);
      this.res.statusCode = 405;
      this.res.end();
      return;
    }
  }

  onReqData(data) {
    this.bp.push(data);
  }

  onReqClose() {
    this.stop();
  }

  onReqError(e) {
    this.stop();
  }

  stop() {
    if (this.isStarting) {
      this.isStarting = false;
      this.bp.stop();
    }
  }

  reject() {
    this.stop();
  }

  * handleData() {

    Logger.log(`[${this.TAG} message parser] start`);
    while (this.isStarting) {
      if (this.bp.need(9)) {
        if (yield) break;
      }
    }

    Logger.log(`[${this.TAG} message parser] done`);
    if (this.isPublisher) {

    } else {
      let publisherId = context.publishers.get(this.playStreamPath);
      if (publisherId != null) {
        context.sessions.get(publisherId).players.delete(this.id);
        context.nodeEvent.emit('donePlay', this.id, this.playStreamPath, this.playArgs);
      }
    }
    context.nodeEvent.emit('doneConnect', this.id, this.connectCmdObj);
    this.res.end();
    context.idlePlayers.delete(this.id);
    context.sessions.delete(this.id);
  }

  respondUnpublish() {
    this.res.end();
  }

  onConnect() {

  }

  onPlay() {

    context.nodeEvent.emit('prePlay', this.id, this.playStreamPath, this.playArgs);
    if (!this.isStarting) {
      return;
    }
    if (this.config.auth !== undefined && this.config.auth.play) {
      let results = NodeCoreUtils.verifyAuth(this.playArgs.sign, this.playStreamPath, this.config.auth.secret);
      if (!results) {
        Logger.error(`[${this.TAG}] Unauthorized. ID=${this.id} streamPath=${this.playStreamPath} sign=${this.playArgs.sign}`);
        this.res.statusCode = 401;
        this.res.end();
        return;
      }
    }

    if (!context.publishers.has(this.playStreamPath)) {
      Logger.error(`[${this.TAG} play] stream not found ` + this.playStreamPath);
      context.idlePlayers.add(this.id);
      return;
    }

    let publisherId = context.publishers.get(this.playStreamPath);
    let publisher = context.sessions.get(publisherId);
    let players = publisher.players;
    players.add(this.id);

    if (this.res.setHeader !== undefined) {
      this.res.setHeader('Content-Type', 'video/x-flv');
      this.res.setHeader('Access-Control-Allow-Origin', this.allow_origin);
    }

    //send FLV header 
    let FLVHeader = Buffer.from([0x46, 0x4C, 0x56, 0x01, 0x00, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00]);
    if (publisher.isFirstAudioReceived) {
      FLVHeader[4] |= 0b00000100;
    }

    if (publisher.isFirstVideoReceived) {
      FLVHeader[4] |= 0b00000001;
    }
    this.res.write(FLVHeader);
    if (publisher.metaData != null) {
      //send Metadata 
      let rtmpHeader = {
        chunkStreamID: 5,
        timestamp: 0,
        messageTypeID: 0x12,
        messageStreamID: 1
      };

      let metaDataFlvMessage = NodeFlvSession.createFlvMessage(rtmpHeader, publisher.metaData);
      this.res.write(metaDataFlvMessage);
    }
    //send aacSequenceHeader
    if (publisher.audioCodec == 10) {
      let rtmpHeader = {
        chunkStreamID: 4,
        timestamp: 0,
        messageTypeID: 0x08,
        messageStreamID: 1
      };
      let flvMessage = NodeFlvSession.createFlvMessage(rtmpHeader, publisher.aacSequenceHeader);
      this.res.write(flvMessage);
    }
    //send avcSequenceHeader
    if (publisher.videoCodec == 7 || publisher.videoCodec == 12) {
      let rtmpHeader = {
        chunkStreamID: 6,
        timestamp: 0,
        messageTypeID: 0x09,
        messageStreamID: 1
      };
      let flvMessage = NodeFlvSession.createFlvMessage(rtmpHeader, publisher.avcSequenceHeader);
      this.res.write(flvMessage);
    }
    //send gop cache
    if (publisher.flvGopCacheQueue != null) {
      for (let flvMessage of publisher.flvGopCacheQueue) {
        this.res.write(flvMessage);
      }
    }
    Logger.log(`[${this.TAG} play] join stream ` + this.playStreamPath);
    context.nodeEvent.emit('postPlay', this.id, this.playStreamPath, this.playArgs);
  }

  onPublish() {

  }

  static createFlvMessage(rtmpHeader, rtmpBody) {
    let FLVTagHeader = Buffer.alloc(11);
    FLVTagHeader[0] = rtmpHeader.messageTypeID;
    FLVTagHeader.writeUIntBE(rtmpBody.length, 1, 3);
    FLVTagHeader[4] = (rtmpHeader.timestamp >> 16) & 0xFF;
    FLVTagHeader[5] = (rtmpHeader.timestamp >> 8) & 0xFF;
    FLVTagHeader[6] = rtmpHeader.timestamp & 0xFF;
    FLVTagHeader[7] = (rtmpHeader.timestamp >> 24) & 0xFF;
    FLVTagHeader.writeUIntBE(0, 8, 3);
    let PreviousTagSizeN = Buffer.alloc(4);
    PreviousTagSizeN.writeUInt32BE(11 + rtmpBody.length);
    return Buffer.concat([FLVTagHeader, rtmpBody, PreviousTagSizeN]);
  }

}

module.exports = NodeFlvSession;
