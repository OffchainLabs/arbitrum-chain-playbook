/**
 * On-the-fly solc compile of a minimal mintable ERC20 used as the Timeboost
 * bidding token. Runs once per process; the result is cached in module scope.
 *
 * Why inline-compile: vendoring a hand-built bytecode hex string is brittle
 * (re-compiling with a different solc version produces a different hash and
 * risks subtle differences). solc 0.8.33 is already a project dep so the
 * compile is fast (<1s) and deterministic.
 */

import { createRequire } from 'node:module';
import type { Hex } from 'viem';

const require_ = createRequire(import.meta.url);
const solc = require_('solc') as { compile: (input: string) => string; version: () => string };

const SOURCE = /* solidity */ `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MintableERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "ERC20: insufficient allowance");
        if (a != type(uint256).max) {
            allowance[from][msg.sender] = a - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "ERC20: insufficient balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
`;

interface CompiledArtifact {
  abi: unknown[];
  bytecode: Hex;
}

let cached: CompiledArtifact | null = null;

export function compileMintableERC20(): CompiledArtifact {
  if (cached) return cached;

  const input = {
    language: 'Solidity',
    sources: { 'MintableERC20.sol': { content: SOURCE } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input))) as {
    contracts?: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
    errors?: { severity: string; formattedMessage: string }[];
  };

  const fatals = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (fatals.length > 0) {
    throw new Error(`solc compile failed:\n${fatals.map((f) => f.formattedMessage).join('\n')}`);
  }

  const contract = out.contracts?.['MintableERC20.sol']?.['MintableERC20'];
  if (!contract) throw new Error('solc returned no MintableERC20 artifact');

  cached = {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as Hex,
  };
  return cached;
}
