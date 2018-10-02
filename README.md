dCurl

Prerequisites: NodeJS v6.10.1 and above

To install:

npm install

To run:

node index.js
use Chrome / Firefox and go to localhost:3000

The jar file is pre-populated, the default output file is named "download".

Chunk size controls the size of the chunk, default (leave blank) is 1048576

Max size controls the max size of the file to download, default (leave blank) is 4194304

Press GET to kick off the process, a bar will show to denote the chunks that have been received (blue) and written (green)

When everything is written, the output path will be displayed. This is a path relative to the location of index.js
