import { inject, injectable, injectFromBase } from 'inversify';
import { ServiceIdentifiers } from '../../container/ServiceIdentifiers';

import * as estraverse from '@javascript-obfuscator/estraverse';
import * as ESTree from 'estree';

import { TNodeWithLexicalScope } from '../../types/node/TNodeWithLexicalScope';
import { TNodeWithLexicalScopeStatements } from '../../types/node/TNodeWithLexicalScopeStatements';

import { IOptions } from '../../interfaces/options/IOptions';
import { IRandomGenerator } from '../../interfaces/utils/IRandomGenerator';
import { IVisitor } from '../../interfaces/node-transformers/IVisitor';

import { NodeTransformationStage } from '../../enums/node-transformers/NodeTransformationStage';
import { NodeTransformer } from '../../enums/node-transformers/NodeTransformer';

import { AbstractNodeTransformer } from '../AbstractNodeTransformer';
import { NodeAppender } from '../../node/NodeAppender';
import { NodeGuards } from '../../node/NodeGuards';
import { NodeUtils } from '../../node/NodeUtils';

/**
 * It's easier to fix "use strict"; placement after obfuscation as a separate stage
 * than ignore this directive in other transformers like control flow and dead code injection transformers
 */
@injectFromBase()
@injectable()
export class DirectivePlacementTransformer extends AbstractNodeTransformer {
    /**
     * @type {NodeTransformer[]}
     */
    public override readonly runAfter: NodeTransformer[] = [NodeTransformer.CustomCodeHelpersTransformer];

    /**
     * @type {WeakMap<TNodeWithLexicalScope, Directive>}
     */
    private readonly lexicalScopeDirectives: WeakMap<TNodeWithLexicalScope, ESTree.Directive> = new WeakMap<
        TNodeWithLexicalScope,
        ESTree.Directive
    >();

    /**
     * @param {IRandomGenerator} randomGenerator
     * @param {IOptions} options
     */
    public constructor(
        @inject(ServiceIdentifiers.IRandomGenerator) randomGenerator: IRandomGenerator,
        @inject(ServiceIdentifiers.IOptions) options: IOptions
    ) {
        super(randomGenerator, options);
    }

    /**
     * Returns the lexical-scope node that owns `node`'s statements, or null if `node` does not
     * hold a directive-prologue-bearing statement list. The top-level `Program` is its own scope
     * (its `parentNode` is null during traversal); a function body `BlockStatement` is owned by
     * its parent function. Handling the `Program` case is what keeps a module-level `'use strict'`
     * from being demoted out of the directive prologue when other transformers prepend statements
     * (e.g. the string-array rotation wrapper).
     *
     * @param {Node} node
     * @param {Node | null} parentNode
     * @returns {Node | null}
     */
    private static getLexicalScopeNode(node: ESTree.Node, parentNode: ESTree.Node | null): ESTree.Node | null {
        if (NodeGuards.isProgramNode(node)) {
            return node;
        }

        if (parentNode && NodeGuards.isNodeWithLexicalScopeStatements(node, parentNode)) {
            return parentNode;
        }

        return null;
    }

    /**
     * @param {NodeTransformationStage} nodeTransformationStage
     * @returns {IVisitor | null}
     */
    public getVisitor(nodeTransformationStage: NodeTransformationStage): IVisitor | null {
        switch (nodeTransformationStage) {
            case NodeTransformationStage.Preparing:
                return {
                    enter: (
                        node: ESTree.Node,
                        parentNode: ESTree.Node | null
                    ): ESTree.Node | estraverse.VisitorOption | undefined => {
                        const scopeNode: ESTree.Node | null = DirectivePlacementTransformer.getLexicalScopeNode(
                            node,
                            parentNode
                        );

                        if (scopeNode) {
                            return this.analyzeNode(<TNodeWithLexicalScopeStatements>node, scopeNode);
                        }
                    }
                };

            case NodeTransformationStage.Finalizing:
                return {
                    enter: (
                        node: ESTree.Node,
                        parentNode: ESTree.Node | null
                    ): ESTree.Node | estraverse.VisitorOption | undefined => {
                        const scopeNode: ESTree.Node | null = DirectivePlacementTransformer.getLexicalScopeNode(
                            node,
                            parentNode
                        );

                        if (scopeNode) {
                            return this.transformNode(<TNodeWithLexicalScopeStatements>node, scopeNode);
                        }
                    }
                };

            default:
                return null;
        }
    }

    /**
     * @param {TNodeWithLexicalScopeStatements} nodeWithLexicalScopeStatements
     * @param {Node} parentNode
     * @returns {TNodeWithLexicalScopeStatements}
     */
    public analyzeNode(
        nodeWithLexicalScopeStatements: TNodeWithLexicalScopeStatements,
        parentNode: ESTree.Node
    ): TNodeWithLexicalScopeStatements {
        if (!NodeGuards.isNodeWithLexicalScope(parentNode)) {
            return nodeWithLexicalScopeStatements;
        }

        // Record the scope's directive-prologue node (e.g. `'use strict'`). Earlier transformers
        // may already have prepended statements ahead of it (notably the string-array wrapper at
        // the top of the program), so the directive is not necessarily `body[0]` by the time this
        // runs — find it wherever it currently sits. Acorn only sets the `directive` field on
        // genuine prologue directives, so scanning by `isDirectiveNode` cannot misclassify an
        // ordinary string-expression statement.
        const directiveNode: ESTree.Directive | undefined = <ESTree.Directive | undefined>(
            nodeWithLexicalScopeStatements.body.find((statementNode: ESTree.Node) =>
                NodeGuards.isDirectiveNode(statementNode)
            )
        );

        if (directiveNode) {
            this.lexicalScopeDirectives.set(parentNode, directiveNode);
        }

        return nodeWithLexicalScopeStatements;
    }

    /**
     * @param {TNodeWithLexicalScopeStatements} nodeWithLexicalScopeStatements
     * @param {Node | null} parentNode
     * @returns {TNodeWithLexicalScope}
     */
    public transformNode(
        nodeWithLexicalScopeStatements: TNodeWithLexicalScopeStatements,
        parentNode: ESTree.Node
    ): TNodeWithLexicalScopeStatements {
        if (!NodeGuards.isNodeWithLexicalScope(parentNode)) {
            return nodeWithLexicalScopeStatements;
        }

        const directiveNode: ESTree.Directive | undefined = this.lexicalScopeDirectives.get(parentNode);

        if (directiveNode) {
            const newDirectiveNode: ESTree.Directive = NodeUtils.clone(directiveNode);

            // append new directive node at the top of lexical scope statements
            NodeAppender.prepend(nodeWithLexicalScopeStatements, [newDirectiveNode]);

            nodeWithLexicalScopeStatements.body = nodeWithLexicalScopeStatements.body.filter(
                (node) => node !== directiveNode
            );
        }

        return nodeWithLexicalScopeStatements;
    }
}
