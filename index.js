const express = require('express');
const app = express();

const http = require('http');
const server = http.createServer(app);
const io = require('socket.io')(server);

const fs = require('fs');
const path = require('path');

const request = require('request');

server.listen(3000);


// Public folder has all the stuff for the front end
app.use(express.static('public'));


io.on('connection', function (socket) {
    console.log('Connected');
    socket.on('request', (r) => {
        console.log(r);
        dCurl.getFile(r.url, r.output, parseInt(r.chunkSize) || 1 << 20, parseInt(r.maxSize) || 4 << 20, socket);
    });
});

const dCurl = {
    requests: [],
    getFile: (url, output, chunkSize, maxSize, socket) => {
        // kicks off the process to get a file

        // the req object represents the state of a request. Since the request is split into multiple http requests, we could be getting back data out of order.
        // the idea here is to keep track of the chunk that comes back based on the content-range response header, then put it into a queue for writing.
        // writing to filesystem is asynchronous, we will be using a simple mechanism: when the file writer is done, it will check the req.blobs for the next thing.
        // if the first element of the req.blobs has a chunk # different from the expected chunk #, it will wait until a request comes in with the correct chunk #.
        // since req.blobs is kept sorted, the first element will always have the smallest chunk #. Once the last chunk # comes in, we know that all chunks are present
        // and therefore the file writer can simply write everything. The task is complete when the last chunk is written.
        // We can tell the last chunk is written by calculating the number of expected chunks as Math.ceil(filesize / size)

        const req = {
            chunkSize,
            maxSize,
            url: url, // URL to get file
            output: '', // output file name
            received: 0, // index of the chunk currently requesting
            nextChunkToWrite: 0, // the chunk we are looking for to write
            blobs: [], // a queue of the data coming back, this queue is processed asynchronously based on requests and fs write
            socket: socket, // reference to the socket object if it exists
            state: {}, // a hashmap of chunk # to state
        };

        if (!output) {
            output = 'download';
        }

        req.output = path.join('output', output);

        console.log(req.chunkSize, req.maxSize);

        dCurl.explore(req, socket);
    },
    // makes a 1 byte request just to find out the size of the file
    // TODO: find a better way to do this
    explore: (req, socket) => {
        const options = {
            headers: {
                Range: `bytes=0-1`
            },
            encoding: 'hex'
        };

        request.get(req.url, options, (err, resp, body) => {
            if(err){
                console.log(err);
            }
            const values = dCurl.parseContentRange(resp);
            let size = values.size;

            // since we are only downloading up to some max size, this gets set here
            if (req.maxSize && size > req.maxSize) {
                size = req.maxSize;
            }

            req.size = size;

            req.maxChunks = Math.ceil(req.size / req.chunkSize);

            for (let i = 0; i < req.maxChunks; i++) {
                dCurl.makeRequest(req, i, socket);
                req.state[i] = 'Requested';
            }

            dCurl.emitState(socket, req);
        });
    },
    // makes the actual request
    makeRequest: (req, chunk, socket) => {
        const start = chunk * req.chunkSize;
        let end = (chunk + 1) * req.chunkSize - 1;

        // adjust end to be size of file if necessary
        if (req.size && end > req.size) {
            end = req.size;
        }
        const options = {
            headers: {
                Range: `bytes=${start}-${end}`
            },
            encoding: 'hex'
        };

        request.get(req.url, options, (err, resp, data) => {
            if (err) {
                // retry
                console.log(err);
                dCurl.makeRequest(req, chunk);
            } else {

                // queue up the data to be written
                req.blobs.push({
                    chunk,
                    data
                });

                // keep blobs in sorted order
                req.blobs.sort((a, b) => {
                    return a.chunk - b.chunk;
                });

                req.received++; // increment number of chunks we've gotten back

                if (req.received >= req.maxChunks) {
                    req.allBlobsDownloaded = true; // mark all blobs downloaded so that writeFile will know to not wait for any more requests to trigger it
                }

                req.state[chunk] = 'Received';
                dCurl.emitState(socket, req);

                // trigger writing to fs
                dCurl.writeFile(req, socket);
            }
        });
    },
    parseContentRange: (resp) => {
        const rangeInfo = resp.headers['content-range'];
        const values = rangeInfo.match(/[\d]+/g).map(v => parseInt(v)); // given the content-range header, use regex to divide up the values
        const start = values[0]; // should match the request range start
        const end = values[1]; // should match the request range end
        let size = values[2]; // should be the total size of the object queried

        return {
            start,
            end,
            size
        }
    },
    // writes the file to the FS based on the req object.
    // Stores a reference to the write stream, which synchronously writes to a file over time
    // The idea here is that every time a request comes back, it triggers this function. This function will use the req object
    // to keep state for what has been written (and thus what can be expected to be written next)
    // Worst case scenario, the data comes back in reverse order, thus this file writer will be writing everything at the very end.
    // A better design potentially is writing to specific positions in a file using the file pointer, this will ensure that everything
    // gets written while not having to keep anything in memory
    // Another solution for larger files is to write the chunks as actual files and then concat the ones that are neighbors, following a system
    // similar to most torrent applications.
    writeFile: (req, socket) => {
        if (!req.ws) {
            req.ws = fs.createWriteStream(req.output, { flags: 'w', encoding: 'hex' });
        }
        if (req.blobs.length > 0) {
            const blob = req.blobs[0];
            if (blob.chunk === req.nextChunkToWrite) {
                // write it!
                req.blobs.shift();
                req.ws.write(blob.data); // this is a synchronous operation
                req.state[blob.chunk] = 'Written';
                req.nextChunkToWrite++;

                dCurl.emitState(socket, req);
            }

            if (req.allBlobsDownloaded) {
                if (req.blobs.length > 0) {
                    dCurl.writeFile(req, socket);
                } else {
                    req.ws.end();
                    console.log('end');
                    if(socket){
                        socket.emit('finished', req.output);
                    }
                }
            } else {
                // we can expect another makeRequest call to trigger writeFile
            }
        }
    },
    emitState: (socket, req) => {
        //console.log(req.state);
        if (socket) {
            socket.emit('state', {
                timestamp: Date.now(),
                state: req.state
            });
        }

    }
}

//dCurl.getFile('http://f30f185f.bwtest-aws.pravala.com/384MB.jar', `${Date.now()}.file`);