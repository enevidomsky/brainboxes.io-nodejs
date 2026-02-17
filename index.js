'use strict';

const net = require('net');
const EventEmitter = require('events');

/**
 * Helper function for converting int to hex
 * @param {number} d 
 * @param {int} padding 
 */
function decimalToHex(d, padding) {
    var hex = Number(d).toString(16);
    padding = typeof (padding) === "undefined" || padding === null ? padding = 2 : padding;

    while (hex.length < padding) {
        hex = "0" + hex;
    }

    return hex;
}

/// commands which have no response
/// #** Synchronized Sampling Command
/// ~** Host is OK Command
/// $AARS Restart the device to power on setting
/// SendCommand resolves immediately for these
const commandsWithoutResponse = [ /#\*\*/, /~\*\*/, /\$[0-9A-F][0-9A-F]RS/ ];

/**
 * 
 */
class EDDevice extends EventEmitter {
    constructor(ip, numInputs = 8, numOutputs = 8) {
        super();
        this.ip = ip;
        this.socket = null;
        this._queue = "";
        // queue of unresolved/outstanding promises functions
        // in the form {resolve, reject}
        this._promiseResolutionQueue = [];
        this._address = 1;
        // number of lines
        this.numInputs = numInputs;
        this.numOutputs = numOutputs;
        this.numLines = numInputs + numOutputs;

        this.connect = this.connect.bind(this);
        this._receiveData = this._receiveData.bind(this);
        this.sendCommand = this.sendCommand.bind(this);
    }
    connect() {
        const that = this;
        return new Promise((resolve, reject) => {
            that.socket = net.createConnection({ port: 9500, host: this.ip });
            that.socket.setEncoding('utf8');
            that.socket.setKeepAlive(true, 2000);
            that.socket.on('data', this._receiveData);
            that.socket.on('end', () => {that.emit('disconnect');});
            that.socket.on('end', () => {that.emit('disconnect');});
            that.socket.on('error', (err) => {that.emit('error', err); reject(err);});
            that.socket.on('connect', () => {that.emit('connect'); resolve();});
        });
    }
    sendCommand(command) {
        var promiseResolve, promiseReject;

        // check if this command should have a response
        const noResponse = commandsWithoutResponse.some( r => command.match(r) != null )

        const prom = new Promise((resolve, reject) => {
            promiseResolve = resolve;
            promiseReject = reject;
            //console.log("TX => "+command)
            this.socket.write(Buffer.from(command+'\r'));
            if(noResponse) {
                resolve();
            }
        });
        // we are resolving or rejecting the promise outside of the promise itself,
        // put the resolve/reject functions into the queue
        if(!noResponse) {
            this._promiseResolutionQueue.push({promiseResolve, promiseReject});
        }

        return prom;
    }
    _receiveData(data) {
        this._queue += data;
        var nextChunk = this._queue.indexOf('\r');
        while (nextChunk > 0) {
            const response = this._queue.slice(0,nextChunk);
            this._queue = this._queue.slice(nextChunk+1);
            nextChunk = this._queue.indexOf('\r');
            //console.log("RX <= " + response)
            this.emit('response', response);
            const promRes = this._promiseResolutionQueue.shift();
            promRes.promiseResolve(response);
        }
    }
    getAllDigitalLineStates() {
        const that = this;
        return this.sendCommand("@"+decimalToHex(this._address, 2))
                .then( response => {
                    if( ! response.startsWith(">") ) {
                        const errMessage = "Failed to get all Digital Line States response: "+response;
                        that.emit('error', errMessage);
                        return Promise.reject(errMessage);
                    }
                    let num = parseInt(response.slice(1), 16);
                    var ioLines = [];
                    // dont know 
                    for(let i = 0; i< that.numLines; i++) {
                        let val = (num >> i) & 0x1;
                        ioLines.push( val );
                    }
                    return ioLines;
                });
    }
    setDigitalOutputLineState(line, state){
        // 2 different functions available depending on if the line is on the top or bottom 8
        // #AAAcDD lower 8 channels
        // #AABcDD upper 8 channels

        const commandType = (line < 8) ? "A" : "B";
        const command = "#" + decimalToHex(this._address, 2) + commandType + (line%8) + '0' + state;
        const that = this;
        return this.sendCommand(command)
                .then( response => {
                    if( response != ">" ) {
                        const errMessage = "Invalid Response " + response;
                        that.emit('error', errMessage);
                        return Promise.reject(errMessage);
                    }
                    return true;
                });
    }
    setAllDigitalOutputStates(states){
        //less than 8 outputs uses 2 bytes, less than 16 4 bytes of hex etc.
        var byteAlign = this.numOutputs <= 8 ? 2 : this.numOutputs <= 16 ? 4 : 6;
        var data = states.reduce( (total, line, index) => total + (line << index) );
        //8.24	@AA(Data) http://www.brainboxes.com/files/pages/support/faqs/docs/AsciiCommands/%40AA(Data).pdf
        const command = `@${decimalToHex(this._address, 2)}${decimalToHex(data, byteAlign)}`;
        return this.sendCommand(command).then( response => {
            if (response == ">") {
                return true; //success
            }
            else if(response == "?") {
                const errMessage = "INVALID command. The ED Device reported that the SetAllOutputLineStates Command " + command + " was INVALID";
                that.emit('error', errMessage);
                return Promise.reject(errMessage);
            }
            else
            {
                const errMessage = "IGNORED command. The ED Device reported that the SetAllOutputLineStates Command " + command + " was IGNORED";
                that.emit('error', errMessage);
                return Promise.reject(errMessage);
            }
        });
    }
    getDigitalInputLineCount(line) {
        //from manual #AAN
        //#	Delimiter character
        //AA	Address of the device to be configured in hexadecimal format (00 to FF)to FF)
        //N	Digital input channel to be read (0 to F)
        const command = "#" + decimalToHex(this._address, 2) + line;
        const that = this;
        return this.sendCommand(command)
                .then( response => {
                    if( !response.startsWith("!01") ) {
                        const errMessage = "Invalid Response " + response;
                        that.emit('error', errMessage);
                        return Promise.reject(errMessage);
                    } 
                    // value already in base 10
                    return parseInt( response.slice(3) ) 
                });
    }
}

module.exports = {
    EDDevice: EDDevice
};
