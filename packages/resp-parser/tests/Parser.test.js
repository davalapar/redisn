/* eslint-disable flowtype/require-parameter-type,no-shadow,no-param-reassign,prefer-destructuring,no-new */
/* eslint-env jest */

const util = require('util');
const assert = require('assert');
const { Buffer } = require('buffer');

const Parser = require('../src/Parser');
const { ReplyError, RedisError, ParserError } = require('../src/ParserErrors');

// Mock the not needed return functions
function returnReply() {
  throw new Error('failed');
}
function returnError() {
  throw new Error('failed');
}
function returnFatalError(err) {
  throw err;
}

function createBufferOfSize(parser, size, str) {
  if (size % 65536 !== 0) {
    throw new Error('Size may only be multiple of 65536');
  }
  str = str || '';
  const lorem =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, ' +
    'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ' +
    'ut aliquip ex ea commodo consequat. Duis aute irure dolor in'; // 256 chars
  const bigStringArray = new Array(2 ** 16 / lorem.length).join(`${lorem} `).split(' '); // Math.pow(2, 16) chars long
  const startBigBuffer = Buffer.from(`${str}$${size}\r\n`);
  const parts = size / 65536;
  const chunks = new Array(parts);
  parser.execute(startBigBuffer);
  for (let i = 0; i < parts; i++) {
    chunks[i] = Buffer.from(`${bigStringArray.join(' ')}.`); // Math.pow(2, 16) chars long
    if (Parser.name === 'JavascriptRedisParser') {
      assert.strictEqual(parser.bufferCache.length, i + 1);
    }
    parser.execute(chunks[i]);
  }
  return chunks;
}

class ExtendedParser extends Parser {
  constructor(opts, noFatal) {
    super(opts);
    this._returnReply = this.options.returnReply || returnReply;
    this._returnError = this.options.returnError || returnError;
    this._returnFatalError =
      this.options.returnFatalError || (noFatal ? this._returnError : returnFatalError);
  }
}

function newParser(options, buffer, noFatal) {
  if (typeof options === 'function') {
    options = {
      returnReply: options,
      returnBuffers: buffer === 'buffer',
    };
  }
  return new ExtendedParser(options, noFatal);
}

describe('Parser', () => {
  describe('parsing', () => {
    let replyCount = 0;
    beforeEach(() => {
      replyCount = 0;
    });

    test('returns buffers if option set', () => {
      const res = 'test';
      let replyCount = 0;

      function checkReply(reply) {
        if (replyCount === 0) {
          assert.strictEqual(reply, res);
        } else {
          assert.strictEqual(reply.inspect(), Buffer.from(res).inspect());
        }
        replyCount++;
      }

      const parser = newParser({
        returnReply: checkReply,
        returnError,
      });

      parser.execute(Buffer.from('+test\r\n'));
      parser.execute(Buffer.from('+test'));
      parser.options.returnBuffers = true;
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\r\n$4\r\ntest\r\n'));
      assert.strictEqual(replyCount, 3);
    });

    test('reset parser', () => {
      function checkReply(reply) {
        assert.strictEqual(reply, 'test');
        replyCount++;
      }
      const parser = newParser(checkReply);
      parser.execute(Buffer.from('$123\r\naaa'));
      parser.reset();
      parser.execute(Buffer.from('+test\r\n'));
      assert.strictEqual(replyCount, 1);
    });

    test('weird things', () => {
      let replyCount = 0;
      const results = [
        [],
        '',
        [0, null, '', 0, '', []],
        9223372036854776,
        '☃',
        [1, 'OK', null],
        null,
        12345,
        [],
        null,
        't',
      ];
      function checkReply(reply) {
        assert.deepEqual(results[replyCount], reply);
        replyCount++;
      }
      const parser = newParser(checkReply);
      parser.execute(Buffer.from('*0\r\n$0\r\n\r\n*6\r\n:\r\n$-1\r\n$0\r\n\r\n:-\r\n$'));
      assert.strictEqual(replyCount, 2);
      parser.execute(
        Buffer.from(`\r\n\r\n*\r\n:9223372036854775\r\n$${Buffer.byteLength('☃')}\r\n☃\r\n`),
      );
      assert.strictEqual(replyCount, 5);
      parser.execute(Buffer.from('*3\r\n:1\r\n+OK\r\n$-1\r\n'));
      assert.strictEqual(replyCount, 6);
      parser.execute(Buffer.from('$-5'));
      assert.strictEqual(replyCount, 6);
      parser.execute(Buffer.from('\r\n:12345\r\n*0\r\n*-1\r\n+t\r\n'));
      assert.strictEqual(replyCount, 11);
    });

    test('should not set the bufferOffset to a negative value', done => {
      const size = 64 * 1024;
      function checkReply() {}
      const parser = newParser(checkReply, 'buffer');
      createBufferOfSize(parser, size * 11);
      createBufferOfSize(parser, size, '\r\n');
      parser.execute(Buffer.from('\r\n'));
      setTimeout(done, 425);
    });

    test('multiple parsers do not interfere', () => {
      const results = [1234567890, 'foo bar baz', 'hello world'];
      function checkReply(reply) {
        assert.strictEqual(reply, results[replyCount]);
        replyCount++;
      }
      const parserOne = newParser(checkReply);
      const parserTwo = newParser(checkReply);
      parserOne.execute(Buffer.from('+foo '));
      parserOne.execute(Buffer.from('bar '));
      assert.strictEqual(replyCount, 0);
      parserTwo.execute(Buffer.from(':1234567890\r\n+hello '));
      assert.strictEqual(replyCount, 1);
      parserTwo.execute(Buffer.from('wor'));
      parserOne.execute(Buffer.from('baz\r\n'));
      assert.strictEqual(replyCount, 2);
      parserTwo.execute(Buffer.from('ld\r\n'));
      assert.strictEqual(replyCount, 3);
    });

    test('multiple parsers do not interfere with bulk strings in arrays', () => {
      const results = [
        ['foo', 'foo bar baz'],
        [1234567890, 'hello world', 'the end'],
        'ttttttttttttttttttttttttttttttttttttttttttttttt',
      ];
      function checkReply(reply) {
        assert.deepEqual(reply, results[replyCount]);
        replyCount++;
      }
      const parserOne = newParser(checkReply);
      const parserTwo = newParser(checkReply);
      parserOne.execute(Buffer.from('*2\r\n+foo\r\n$11\r\nfoo '));
      parserOne.execute(Buffer.from('bar '));
      assert.strictEqual(replyCount, 0);
      parserTwo.execute(Buffer.from('*3\r\n:1234567890\r\n$11\r\nhello '));
      assert.strictEqual(replyCount, 0);
      parserOne.execute(Buffer.from('baz\r\n+ttttttttttttttttttttttttt'));
      assert.strictEqual(replyCount, 1);
      parserTwo.execute(Buffer.from('wor'));
      parserTwo.execute(Buffer.from('ld\r\n'));
      assert.strictEqual(replyCount, 1);
      parserTwo.execute(Buffer.from('+the end\r\n'));
      assert.strictEqual(replyCount, 2);
      parserOne.execute(Buffer.from('tttttttttttttttttttttt\r\n'));
    });

    test('returned buffers do not get mutated', () => {
      const results = [Buffer.from('aaaaaaaaaa'), Buffer.from('zzzzzzzzzz')];
      function checkReply(reply) {
        assert.deepEqual(results[replyCount], reply);
        results[replyCount] = reply;
        replyCount++;
      }
      const parser = newParser(checkReply, 'buffer');
      parser.execute(Buffer.from('$10\r\naaaaa'));
      parser.execute(Buffer.from('aaaaa\r\n'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('$10\r\nzzzzz'));
      parser.execute(Buffer.from('zzzzz\r\n'));
      assert.strictEqual(replyCount, 2);
      const str = results[0].toString();
      for (let i = 0; i < str.length; i++) {
        assert.strictEqual(str.charAt(i), 'a');
      }
    });

    test('chunks getting to big for the bufferPool', () => {
      // This is a edge case. Chunks should not exceed Math.pow(2, 16) bytes
      const lorem =
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit, ' +
        'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
        'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ' +
        'ut aliquip ex ea commodo consequat. Duis aute irure dolor in'; // 256 chars
      const bigString = new Array(2 ** 17 / lorem.length + 1).join(lorem); // Math.pow(2, 17) chars long
      const sizes = [4, 2 ** 17];
      function checkReply(reply) {
        assert.strictEqual(reply.length, sizes[replyCount]);
        replyCount++;
      }
      const parser = newParser(checkReply);
      parser.execute(Buffer.from('+test'));
      assert.strictEqual(replyCount, 0);
      parser.execute(Buffer.from('\r\n+'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from(bigString));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\r\n'));
      assert.strictEqual(replyCount, 2);
    });

    test('handles multi-bulk reply and check context binding', () => {
      function Abc() {}
      Abc.prototype.checkReply = function(reply) {
        assert.strictEqual(typeof this.log, 'function');
        assert.deepEqual(reply, [['a']], 'Expecting multi-bulk reply of [["a"]]');
        replyCount++;
      };
      Abc.prototype.log = console.log;
      const test = new Abc();
      const parser = newParser({
        returnReply(reply) {
          test.checkReply(reply);
        },
      });

      parser.execute(Buffer.from('*1\r\n*1\r\n$1\r\na\r\n'));
      assert.strictEqual(replyCount, 1);

      parser.execute(Buffer.from('*1\r\n*1\r'));
      parser.execute(Buffer.from('\n$1\r\na\r\n'));
      assert.strictEqual(replyCount, 2);

      parser.execute(Buffer.from('*1\r\n*1\r\n'));
      parser.execute(Buffer.from('$1\r\na\r\n'));

      assert.strictEqual(replyCount, 3, 'check reply should have been called three times');
    });

    test('parser error', () => {
      function Abc() {}
      Abc.prototype.checkReply = function(err) {
        assert.strictEqual(typeof this.log, 'function');
        assert.strictEqual(err.message, 'Protocol error, got "a" as reply type byte');
        assert.strictEqual(err.name, 'ParserError');
        assert(err instanceof RedisError);
        assert(err instanceof ParserError);
        assert(err instanceof Error);
        assert(err.offset);
        assert(err.buffer);
        assert(/\[97,42,49,13,42,49,13,36,49,96,122,97,115,100,13,10,97]/.test(err.buffer));
        assert(/ParserError: Protocol error, got "a" as reply type byte/.test(util.inspect(err)));
        replyCount++;
      };
      Abc.prototype.log = console.log;
      const test = new Abc();
      const parser = newParser({
        returnFatalError(err) {
          test.checkReply(err);
        },
      });

      parser.execute(Buffer.from('a*1\r*1\r$1`zasd\r\na'));
      assert.strictEqual(replyCount, 1);
    });

    test('parser error resets the buffer', () => {
      let errCount = 0;
      function checkReply(reply) {
        assert.strictEqual(reply.length, 1);
        assert(Buffer.isBuffer(reply[0]));
        assert.strictEqual(reply[0].toString(), 'CCC');
        replyCount++;
      }
      function checkError(err) {
        assert.strictEqual(err.message, 'Protocol error, got "b" as reply type byte');
        errCount++;
      }
      const parser = newParser({
        returnReply: checkReply,
        returnError: checkError,
        returnFatalError: checkError,
        returnBuffers: true,
      });

      // The chunk contains valid data after the protocol error
      parser.execute(Buffer.from('*1\r\n+CCC\r\nb$1\r\nz\r\n+abc\r\n'));
      assert.strictEqual(replyCount, 1);
      assert.strictEqual(errCount, 1);
      parser.execute(Buffer.from('*1\r\n+CCC\r\n'));
      assert.strictEqual(replyCount, 2);
      parser.execute(Buffer.from('-Protocol error, got "b" as reply type byte\r\n'));
      assert.strictEqual(errCount, 2);
    });

    test('parser error v3 without returnFatalError specified', () => {
      let errCount = 0;
      function checkReply(reply) {
        assert.strictEqual(reply[0], 'OK');
        replyCount++;
      }
      function checkError(err) {
        assert.strictEqual(err.message, 'Protocol error, got "\\n" as reply type byte');
        errCount++;
      }
      const parser = newParser(
        {
          returnReply: checkReply,
          returnError: checkError,
        },
        null,
        true,
      );

      parser.execute(Buffer.from('*1\r\n+OK\r\n\n+zasd\r\n'));
      assert.strictEqual(replyCount, 1);
      assert.strictEqual(errCount, 1);
    });

    test('should handle \\r and \\n characters properly', () => {
      // If a string contains \r or \n characters it will always be send as a bulk string
      const entries = [
        'foo\r',
        'foo\r\nbar',
        '\r\nСанкт-Пет',
        'foo\r\n',
        'foo',
        'foobar',
        'foo\r',
        'äfooöü',
        'abc',
      ];
      function checkReply(reply) {
        assert.strictEqual(reply, entries[replyCount]);
        replyCount++;
      }
      const parser = newParser(checkReply);

      parser.execute(Buffer.from('$4\r\nfoo\r\r\n$8\r\nfoo\r\nbar\r\n$19\r\n\r\n'));
      parser.execute(Buffer.from([208, 161, 208, 176, 208, 189, 208]));
      parser.execute(Buffer.from([186, 209, 130, 45, 208, 159, 208, 181, 209, 130]));
      assert.strictEqual(replyCount, 2);
      parser.execute(Buffer.from('\r\n$5\r\nfoo\r\n\r\n'));
      assert.strictEqual(replyCount, 4);
      parser.execute(Buffer.from('+foo\r'));
      assert.strictEqual(replyCount, 4);
      parser.execute(Buffer.from('\n$6\r\nfoobar\r'));
      assert.strictEqual(replyCount, 5);
      parser.execute(Buffer.from('\n$4\r\nfoo\r\r\n'));
      assert.strictEqual(replyCount, 7);
      parser.execute(Buffer.from('$9\r\näfo'));
      parser.execute(Buffer.from('oö'));
      parser.execute(Buffer.from('ü\r'));
      assert.strictEqual(replyCount, 7);
      parser.execute(Buffer.from('\n+abc\r\n'));
      assert.strictEqual(replyCount, 9);
    });

    test('line breaks in the beginning of the last chunk', () => {
      function checkReply(reply) {
        assert.deepEqual(reply, [['a']], 'Expecting multi-bulk reply of [["a"]]');
        replyCount++;
      }
      const parser = newParser(checkReply);

      parser.execute(Buffer.from('*1\r\n*1\r\n$1\r\na'));
      assert.strictEqual(replyCount, 0);

      parser.execute(Buffer.from('\r\n*1\r\n*1\r'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\n$1\r\na\r\n*1\r\n*1\r\n$1\r\na\r\n'));

      assert.strictEqual(replyCount, 3, 'check reply should have been called three times');
    });

    test('multiple chunks in a bulk string', () => {
      function checkReply(reply) {
        assert.strictEqual(
          reply,
          'abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij',
        );
        replyCount++;
      }
      const parser = newParser(checkReply);

      parser.execute(Buffer.from('$100\r\nabcdefghij'));
      parser.execute(Buffer.from('abcdefghijabcdefghijabcdefghij'));
      parser.execute(Buffer.from('abcdefghijabcdefghijabcdefghij'));
      parser.execute(Buffer.from('abcdefghijabcdefghijabcdefghij'));
      assert.strictEqual(replyCount, 0);
      parser.execute(Buffer.from('\r\n'));
      assert.strictEqual(replyCount, 1);

      parser.execute(Buffer.from('$100\r'));
      parser.execute(Buffer.from('\nabcdefghijabcdefghijabcdefghijabcdefghij'));
      parser.execute(Buffer.from('abcdefghijabcdefghijabcdefghij'));
      parser.execute(Buffer.from('abcdefghijabcdefghij'));
      assert.strictEqual(replyCount, 1);
      parser.execute(
        Buffer.from(
          'abcdefghij\r\n' +
            '$100\r\nabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij\r\n' +
            '$100\r\nabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij',
        ),
      );
      assert.strictEqual(replyCount, 3);
      parser.execute(Buffer.from('abcdefghijabcdefghijabcdefghij\r'));
      assert.strictEqual(replyCount, 3);
      parser.execute(Buffer.from('\n'));

      assert.strictEqual(replyCount, 4, 'check reply should have been called three times');
    });

    test('multiple chunks with arrays different types', () => {
      const predefinedData = [
        'abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij',
        'test',
        100,
        new ReplyError('Error message'),
        ['The force awakens'],
        new ReplyError(),
      ];
      function checkReply(reply) {
        for (let i = 0; i < reply.length; i++) {
          if (Array.isArray(reply[i])) {
            reply[i].forEach((reply, j) => {
              assert.strictEqual(reply, predefinedData[i][j]);
            });
          } else if (reply[i] instanceof Error) {
            assert.strictEqual(reply[i].message, predefinedData[i].message);
          } else {
            assert.strictEqual(reply[i], predefinedData[i]);
          }
        }
        replyCount++;
      }

      const parser = newParser({
        returnReply: checkReply,
        returnBuffers: false,
      });

      parser.execute(Buffer.from('*6\r\n$100\r\nabcdefghij'));
      parser.execute(Buffer.from('abcdefghijabcdefghijabcdefghij'));
      parser.execute(Buffer.from('abcdefghijabcdefghijabcdefghij'));
      parser.execute(Buffer.from('abcdefghijabcdefghijabcdefghij\r\n'));
      parser.execute(Buffer.from('+test\r'));
      parser.execute(Buffer.from('\n:100'));
      parser.execute(Buffer.from('\r\n-Error message'));
      parser.execute(Buffer.from('\r\n*1\r\n$17\r\nThe force'));
      assert.strictEqual(replyCount, 0);
      parser.execute(Buffer.from(' awakens\r\n-\r\n$5'));
      assert.strictEqual(replyCount, 1);
    });

    test('multiple chunks with nested partial arrays', () => {
      const predefinedData = ['abcdefghijabcdefghij', 100, '1234567890', 100];
      function checkReply(reply) {
        assert.strictEqual(reply.length, 1);
        for (let i = 0; i < reply[0].length; i++) {
          assert.strictEqual(reply[0][i], predefinedData[i]);
        }
        replyCount++;
      }
      const parser = newParser({
        returnReply: checkReply,
      });
      parser.execute(Buffer.from('*1\r\n*4\r\n+abcdefghijabcdefghij\r\n:100'));
      parser.execute(Buffer.from('\r\n$10\r\n1234567890\r\n:100'));
      assert.strictEqual(replyCount, 0);
      parser.execute(Buffer.from('\r\n'));
      assert.strictEqual(replyCount, 1);
    });

    test('return normal errors', () => {
      function checkReply(reply) {
        assert.strictEqual(reply.message, 'Error message');
        replyCount++;
      }
      const parser = newParser({
        returnError: checkReply,
      });

      parser.execute(Buffer.from('-Error '));
      parser.execute(Buffer.from('message\r\n*3\r\n$17\r\nThe force'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from(' awakens\r\n$5'));
      assert.strictEqual(replyCount, 1);
    });

    test('return null for empty arrays and empty bulk strings', () => {
      function checkReply(reply) {
        assert.strictEqual(reply, null);
        replyCount++;
      }
      const parser = newParser(checkReply);

      parser.execute(Buffer.from('$-1\r\n*-'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('1'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\r\n$-'));
      assert.strictEqual(replyCount, 2);
    });

    test('return value even if all chunks are only 1 character long', () => {
      function checkReply(reply) {
        assert.strictEqual(reply, 1);
        replyCount++;
      }
      const parser = newParser(checkReply);

      parser.execute(Buffer.from(':'));
      assert.strictEqual(replyCount, 0);
      parser.execute(Buffer.from('1'));
      parser.execute(Buffer.from('\r'));
      assert.strictEqual(replyCount, 0);
      parser.execute(Buffer.from('\n'));
      assert.strictEqual(replyCount, 1);
    });

    test('do not return before \\r\\n', () => {
      function checkReply(reply) {
        assert.strictEqual(reply, 1);
        replyCount++;
      }
      const parser = newParser(checkReply);

      parser.execute(Buffer.from(':1\r\n:'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('1'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\r'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\n'));
      assert.strictEqual(replyCount, 2);
    });

    test('return data as buffer if requested', () => {
      function checkReply(reply) {
        if (Array.isArray(reply)) {
          reply = reply[0];
        }
        assert(Buffer.isBuffer(reply));
        assert.strictEqual(reply.inspect(), Buffer.from('test').inspect());
        replyCount++;
      }
      const parser = newParser(checkReply, 'buffer');

      parser.execute(Buffer.from('+test\r\n'));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('$4\r\ntest\r'));
      parser.execute(Buffer.from('\n'));
      assert.strictEqual(replyCount, 2);
      parser.execute(Buffer.from('*1\r\n$4\r\nte'));
      parser.execute(Buffer.from('st\r'));
      parser.execute(Buffer.from('\n'));
      assert.strictEqual(replyCount, 3);
    });

    test('handle special case buffer sizes properly', () => {
      const entries = ['test test ', 'test test test test ', 1234];
      function checkReply(reply) {
        assert.strictEqual(reply, entries[replyCount]);
        replyCount++;
      }
      const parser = newParser(checkReply);
      parser.execute(Buffer.from('$10\r\ntest '));
      assert.strictEqual(replyCount, 0);
      parser.execute(Buffer.from('test \r\n$20\r\ntest test test test \r\n:1234\r'));
      assert.strictEqual(replyCount, 2);
      parser.execute(Buffer.from('\n'));
      assert.strictEqual(replyCount, 3);
    });

    test('return numbers as strings', () => {
      const entries = [
        '123',
        '590295810358705700002',
        '-99999999999999999',
        '4294967290',
        '90071992547409920',
        '10000040000000000000000000000000000000020',
      ];
      function checkReply(reply) {
        assert.strictEqual(typeof reply, 'string');
        assert.strictEqual(reply, entries[replyCount]);
        replyCount++;
      }
      const parser = newParser({
        returnReply: checkReply,
        stringNumbers: true,
      });
      parser.execute(
        Buffer.from(
          ':123\r\n:590295810358705700002\r\n:-99999999999999999\r\n:4294967290\r\n:90071992547409920\r\n:10000040000000000000000000000000000000020\r\n',
        ),
      );
      assert.strictEqual(replyCount, 6);
    });

    test('handle big numbers', () => {
      let number = 9007199254740991; // Number.MAX_SAFE_INTEGER
      function checkReply(reply) {
        assert.strictEqual(reply, number++);
        replyCount++;
      }
      const parser = newParser(checkReply);
      parser.execute(Buffer.from(`:${number}\r\n`));
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from(`:${number}\r\n`));
      assert.strictEqual(replyCount, 2);
    });

    test('handle big data with buffers', done => {
      let chunks;
      const replies = [];
      const jsParser = Parser.name === 'JavascriptRedisParser';
      function checkReply(reply) {
        replies.push(reply);
        replyCount++;
      }
      const parser = newParser(checkReply, 'buffer');
      parser.execute(Buffer.from('+test'));
      assert.strictEqual(replyCount, 0);
      createBufferOfSize(parser, 128 * 1024, '\r\n');
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\r\n'));
      assert.strictEqual(replyCount, 2);
      setTimeout(() => {
        parser.execute(Buffer.from('+test'));
        assert.strictEqual(replyCount, 2);
        chunks = createBufferOfSize(parser, 256 * 1024, '\r\n');
        assert.strictEqual(replyCount, 3);
        parser.execute(Buffer.from('\r\n'));
        assert.strictEqual(replyCount, 4);
      }, 20);
      // Delay done so the bufferPool is cleared and tested
      // If the buffer is not cleared, the coverage is not going to be at 100
      setTimeout(() => {
        const totalBuffer = Buffer.concat(chunks).toString();
        assert.strictEqual(replies[3].toString(), totalBuffer);
        done();
      }, jsParser ? 1400 : 40);
    });

    test('handle big data', () => {
      function checkReply(reply) {
        assert.strictEqual(reply.length, 4 * 1024 * 1024);
        replyCount++;
      }
      const parser = newParser(checkReply);
      createBufferOfSize(parser, 4 * 1024 * 1024);
      assert.strictEqual(replyCount, 0);
      parser.execute(Buffer.from('\r\n'));
      assert.strictEqual(replyCount, 1);
    });

    test('handle data with buffers', done => {
      const size = 5.5 * 1024 * 1024;
      const replyLen = [size, size * 2, 11, 11];
      function checkReply(reply) {
        assert.strictEqual(reply.length, replyLen[replyCount]);
        replyCount++;
      }
      const parser = newParser(checkReply, 'buffer');
      createBufferOfSize(parser, size);
      assert.strictEqual(replyCount, 0);
      createBufferOfSize(parser, size * 2, '\r\n');
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\r\n+hello world'));
      assert.strictEqual(replyCount, 2);
      parser.execute(Buffer.from('\r\n$11\r\nhuge'));
      setTimeout(() => {
        parser.execute(Buffer.from(' buffer\r\n'));
        assert.strictEqual(replyCount, 4);
        done();
      }, 60);
    });

    test('handle big data 2 with buffers', done => {
      const size = 111.5 * 1024 * 1024;
      const replyLen = [size, size * 2, 11, 11];
      function checkReply(reply) {
        assert.strictEqual(reply.length, replyLen[replyCount]);
        replyCount++;
      }
      const parser = newParser(checkReply, 'buffer');
      createBufferOfSize(parser, size);
      assert.strictEqual(replyCount, 0);
      createBufferOfSize(parser, size * 2, '\r\n');
      assert.strictEqual(replyCount, 1);
      parser.execute(Buffer.from('\r\n+hello world'));
      assert.strictEqual(replyCount, 2);
      parser.execute(Buffer.from('\r\n$11\r\nhuge'));
      setTimeout(() => {
        parser.execute(Buffer.from(' buffer\r\n'));
        assert.strictEqual(replyCount, 4);
        done();
      }, 60);
    });
  });
});