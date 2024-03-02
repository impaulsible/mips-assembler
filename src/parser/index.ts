import { range } from 'lodash-es';

type InstructionBase = {
  original: string;
  opcode: number;
  address: number;
  hex: string;
};

export type RType = InstructionBase & {
  type: 'R';
  opcode: 0;
  rs: number;
  rt: number;
  rd: number;
  shamt: number;
  funct: number;
};

export type IType = InstructionBase & {
  type: 'I';
  rs: number;
  rt: number;
  immediate: number;
};

export type JType = InstructionBase & {
  type: 'J';
  target: number;
};

export type Instruction = RType | IType | JType;

type Context = {
  labels: Record<string, number>;
  startingAddress: number;
  address: number;
};

const RTYPE = {
  sll: 0,
  srl: 1,
  jr: 8,
  add: 32,
  sub: 34,
  and: 36,
  or: 37,
  slt: 42,
};

const JTYPE = {
  j: 2,
  jal: 3,
};

const BRANCH = {
  beq: 4,
  beqz: 4,
  bne: 5,
  blez: 6,
  bgtz: 7,
};

const MEMORY = {
  lb: 32,
  lh: 33,
  lwl: 34,
  lw: 35,
  lbu: 36,
  lhu: 37,
  lwr: 38,
  sb: 40,
  sh: 41,
  swl: 42,
  sw: 43,
  swr: 46,
};

const ITYPE = {
  ...MEMORY,
  ...BRANCH,
  addi: 8,
  subi: 10,
  andi: 12,
  ori: 13,
  slti: 10,
  lui: 15,
  lw: 35,
  sw: 43,
  beq: 4,
};

const COMMAND_SCHEMAS = {
  RTYPE: new RegExp(
    // Matches lines like `add $t0, $t1, $t2`
    `(${Object.keys(RTYPE).join('|')})\\s+\\$(\\w+),\\s+(?:\\$(\\w+),)?\\s*\\$(\\w+)\\s*(?:,\\s*(\\w+))?$`
  ),
  ITYPE1: new RegExp(
    // Matches lines like `addi $t0, $t1, 10`, and `beq $t0, $t1, L1`
    `(${Object.keys(ITYPE).join('|')})\\s+\\$(\\w+),(?:\\s+\\$(\\w+),)?\\s*(-?\\w+)$`
  ),
  ITYPE2: new RegExp(
    // Matches memory instructions like `lw $t0, 10($t1)` and `sw $t0, ($t1)`
    `(${Object.keys(ITYPE).join('|')})\\s+\\$(\\w+),\\s+(-?\\w+)?(?:\\(\\$(\\w+)\\))?$`
  ),
};

/// Create a part of the register map.
const createRegisterMappings = (
  prefix: string,
  offset: number,
  count: number,
  start: number = 0
) =>
  range(count).reduce(
    (acc, i) => ({ ...acc, [`${prefix}${start + i}`]: i + offset }),
    {}
  );

const REGISTER_MAP = {
  zero: 0,
  at: 1,
  ...createRegisterMappings('v', 2, 2),
  ...createRegisterMappings('a', 4, 4),
  ...createRegisterMappings('t', 8, 8),
  ...createRegisterMappings('s', 16, 8),
  ...createRegisterMappings('t', 24, 2, 8),
  ...createRegisterMappings('k', 26, 2),
  gp: 28,
  sp: 29,
  fp: 30,
  ra: 31,
  // Also map the numbers to themselves
  ...range(32).reduce((acc, i) => ({ ...acc, [i.toString()]: i }), {}),
};

/// Parse a string to an integer, allowing for hex numbers
const parseIntMaybeHex = (str: string) =>
  str.startsWith('0x') ? parseInt(str, 16) : parseInt(str, 10);

/// Convert a number to a 2's complement representation
export const to2k = (num: number, width = 8) =>
  num >= 0 ? num : Math.pow(2, width) + num;

/// Convert a number to a 2's complement hex representation
const toTwosComplementHex = (num: number, width = 8) =>
  to2k(num, width * 4)
    .toString(16)
    .padStart(width, '0');

/// Parse a jump instruction
const parseJType = (
  line: string,
  { labels, address }: Context
): JType | null => {
  const [name, label] = line.split(' ');

  if (!Object.keys(JTYPE).includes(name)) return null;

  const target = labels[label] ?? parseIntMaybeHex(label);

  return {
    original: line,
    type: 'J',
    opcode: JTYPE[name],
    address,
    target,
    hex: calcJTypeHex({ opcode: JTYPE[name], target }),
  };
};

/// Calculate the hex representation of a jump instruction
const calcJTypeHex = (instruction: Pick<JType, 'opcode' | 'target'>) => {
  const { opcode, target } = instruction;
  return `0x${toTwosComplementHex((opcode << 26) | ((target & 0x3ffffff) >> 2))}`;
};

/// Parse an R type instruction
const parseRType = (line: string, { address }: Context): RType | null => {
  const match = line.match(COMMAND_SCHEMAS.RTYPE);

  if (match === null) return null;

  const [, name, rdString, rsString, rtString, shamtString] = match;

  const [rd, rs, rt] = [rdString, rsString, rtString].map(
    (reg) => REGISTER_MAP[reg] ?? 0
  );

  const shamt = shamtString ? parseIntMaybeHex(shamtString) : 0;

  const funct = RTYPE[name];

  return {
    original: line,
    type: 'R' as const,
    opcode: 0 as const,
    rs,
    rt,
    rd,
    shamt,
    funct,
    address,
    hex: calcRTypeHex({ rs, rt, rd, shamt, funct }),
  };
};

const calcRTypeHex = (
  instruction: Pick<RType, 'rs' | 'rt' | 'rd' | 'shamt' | 'funct'>
) => {
  const { rs, rt, rd, shamt, funct } = instruction;
  const shamtNormalized = parseInt(toTwosComplementHex(shamt, 5), 16);
  return `0x${toTwosComplementHex(
    (rs << 21) | (rt << 16) | (rd << 11) | (shamtNormalized << 6) | funct
  )}`;
};

/// Parse the two possible I type schemas into a common format
const parseITypeSchemas = (line: string) => {
  const matchA = line.match(COMMAND_SCHEMAS.ITYPE1);
  const matchB = line.match(COMMAND_SCHEMAS.ITYPE2);

  if (matchA) {
    const [, name, rs, rt, immediate] = matchA;
    return { name, rs, rt, immediate };
  } else if (matchB) {
    const [, name, rt, immediate = '0', rs] = matchB;
    return { name, rt, immediate, rs };
  }

  return null;
};

/// Parse an I type instruction
const parseIType = (
  line: string,
  { address, labels }: Context
): IType | null => {
  const parsedSchema = parseITypeSchemas(line);

  if (parsedSchema === null) return null;

  const {
    name,
    rt: rtString,
    rs: rsString,
    immediate: immediateString,
  } = parsedSchema;

  const opcode = ITYPE[name];

  const isBranch = Object.keys(BRANCH).includes(name);

  // If it's a branch instruction, calculate the branch offset
  const branchOffset =
    ((labels[immediateString] ?? parseIntMaybeHex(immediateString)) -
      (address + 4)) /
    4;

  // Immediate might be negative, so we need to convert it to 2's complement
  const immediate = to2k(
    isBranch ? branchOffset : parseIntMaybeHex(immediateString),
    16
  );

  const rt = REGISTER_MAP[rtString] ?? 0;
  const rs = REGISTER_MAP[rsString] ?? 0;

  return {
    type: 'I' as const,
    original: line,
    opcode,
    address,
    rs,
    rt,
    immediate,
    hex: calcITypeHex({ opcode, rs, rt, immediate }),
  };
};

/// Calculate the hex representation of an I type instruction
const calcITypeHex = (
  instruction: Pick<IType, 'opcode' | 'rs' | 'rt' | 'immediate'>
) => {
  const { opcode, rs, rt, immediate } = instruction;
  const immediate2k = to2k(immediate, 16);
  return `0x${toTwosComplementHex(
    (opcode << 26) | (rt << 16) | (rs << 21) | immediate2k
  )}`;
};

/// Parse a line of code
export const parseLine = (line: string, address: Context) =>
  parseRType(line, address) ??
  parseIType(line, address) ??
  parseJType(line, address);

/// Parse a program
export const parse = (code: string, startingAddressString: string) => {
  const lines = code
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const startingAddress = parseIntMaybeHex(startingAddressString);

  // Compute the label addresses
  const labels = {};
  let numLabels = 0;
  lines.forEach((line, idx) => {
    if (line.endsWith(':')) {
      labels[line.slice(0, -1)] = startingAddress + (idx - numLabels) * 4;
      numLabels++;
    }
  });

  const globalContext = { labels, startingAddress };

  return lines
    .filter((line) => !line.endsWith(':'))
    .map((line, idx) =>
      parseLine(line, {
        ...globalContext,
        address: startingAddress + 4 * idx,
      })
    );
};
