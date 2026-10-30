import { inject, injectable, injectFromBase } from 'inversify';
import { ServiceIdentifiers } from '../../container/ServiceIdentifiers';

import * as estraverse from '@javascript-obfuscator/estraverse';
import * as ESTree from 'estree';

import { TObjectExpressionExtractorFactory } from '../../types/container/node-transformers/TObjectExpressionExtractorFactory';

import { IOptions } from '../../interfaces/options/IOptions';
import { IRandomGenerator } from '../../interfaces/utils/IRandomGenerator';
import { IVisitor } from '../../interfaces/node-transformers/IVisitor';

import { NodeTransformationStage } from '../../enums/node-transformers/NodeTransformationStage';
import { ObjectExpressionExtractor } from '../../enums/node-transformers/converting-transformers/properties-extractors/ObjectExpressionExtractor';

import { AbstractNodeTransformer } from '../AbstractNodeTransformer';
import { NodeGuards } from '../../node/NodeGuards';
import { NodeStatementUtils } from '../../node/NodeStatementUtils';

@injectFromBase()
@injectable()
export class ObjectExpressionKeysTransformer extends AbstractNodeTransformer {
    /**
     * @type {string}
     */
    private static readonly thisIdentifierName: string = 'this';

    /**
     * @type {ObjectExpressionExtractor[]}
     */
    private static readonly objectExpressionExtractorNames: ObjectExpressionExtractor[] = [
        ObjectExpressionExtractor.ObjectExpressionToVariableDeclarationExtractor,
        ObjectExpressionExtractor.BasePropertiesExtractor
    ];

    /**
     * @type {TObjectExpressionExtractorFactory}
     */
    private readonly objectExpressionExtractorFactory: TObjectExpressionExtractorFactory;

    /**
     * @param {TObjectExpressionExtractorFactory} objectExpressionExtractorFactory
     * @param {IRandomGenerator} randomGenerator
     * @param {IOptions} options
     */
    public constructor(
        @inject(ServiceIdentifiers.Factory__IObjectExpressionExtractor)
        objectExpressionExtractorFactory: TObjectExpressionExtractorFactory,
        @inject(ServiceIdentifiers.IRandomGenerator) randomGenerator: IRandomGenerator,
        @inject(ServiceIdentifiers.IOptions) options: IOptions
    ) {
        super(randomGenerator, options);

        this.objectExpressionExtractorFactory = objectExpressionExtractorFactory;
    }

    /**
     * Combined prohibition check result
     */
    private static checkProhibitedPatterns(
        objectExpressionNode: ESTree.ObjectExpression,
        objectExpressionHostNode: ESTree.Node
    ): { hasReferencedIdentifier: boolean; hasCallExpression: boolean } {
        const identifierNamesSet: Set<string> = new Set();

        let hasReferencedIdentifier: boolean = false;
        let hasCallExpression: boolean = false;
        let isInsideObjectExpression: boolean = false;

        estraverse.traverse(objectExpressionHostNode, {
            // eslint-disable-next-line complexity
            enter: (node: ESTree.Node): void | estraverse.VisitorOption => {
                if (node === objectExpressionNode) {
                    isInsideObjectExpression = true;
                }

                if (isInsideObjectExpression && !hasCallExpression) {
                    if (NodeGuards.isCallExpressionNode(node) || NodeGuards.isNewExpressionNode(node)) {
                        hasCallExpression = true;
                    }
                }

                if (NodeGuards.isIdentifierNode(node) || NodeGuards.isThisExpressionNode(node)) {
                    const identifierName: string = NodeGuards.isIdentifierNode(node)
                        ? node.name
                        : ObjectExpressionKeysTransformer.thisIdentifierName;

                    if (!isInsideObjectExpression) {
                        identifierNamesSet.add(identifierName);
                    } else if (identifierNamesSet.has(identifierName)) {
                        hasReferencedIdentifier = true;
                    }
                }

                if (hasReferencedIdentifier && hasCallExpression) {
                    return estraverse.VisitorOption.Break;
                }
            },
            leave: (node: ESTree.Node): void | estraverse.VisitorOption => {
                if (node === objectExpressionNode) {
                    isInsideObjectExpression = false;
                    if (hasReferencedIdentifier || hasCallExpression) {
                        return estraverse.VisitorOption.Break;
                    }
                }
            }
        });

        return { hasReferencedIdentifier, hasCallExpression };
    }

    /**
     * @param {ObjectExpression} objectExpressionNode
     * @param {Statement} objectExpressionHostStatement
     * @returns {boolean}
     */
    private static isProhibitedObjectExpressionNode(
        objectExpressionNode: ESTree.ObjectExpression,
        objectExpressionHostStatement: ESTree.Statement
    ): boolean {
        if (
            ObjectExpressionKeysTransformer.isProhibitedEvaluationBoundary(
                objectExpressionNode,
                objectExpressionHostStatement
            ) ||
            ObjectExpressionKeysTransformer.isProhibitedConditionalEvaluation(
                objectExpressionNode,
                objectExpressionHostStatement
            ) ||
            ObjectExpressionKeysTransformer.isProhibitedSequenceExpression(objectExpressionNode) ||
            ObjectExpressionKeysTransformer.isProhibitedLoopBody(objectExpressionNode)
        ) {
            return true;
        }

        const { hasReferencedIdentifier, hasCallExpression } = ObjectExpressionKeysTransformer.checkProhibitedPatterns(
            objectExpressionNode,
            objectExpressionHostStatement
        );

        return hasReferencedIdentifier || hasCallExpression;
    }

    /**
     * @param {ObjectExpression} objectExpressionNode
     * @returns {boolean}
     */
    private static isProhibitedLoopBody(objectExpressionNode: ESTree.ObjectExpression): boolean {
        let currentNode: ESTree.Node | undefined = objectExpressionNode;

        while (currentNode) {
            const parentNode: ESTree.Node | undefined = currentNode.parentNode;

            if (!parentNode || parentNode === currentNode) {
                break;
            }

            const isNonBlockLoopBody: boolean =
                NodeGuards.isLoopStatementNode(parentNode) &&
                parentNode.body === currentNode &&
                !NodeGuards.isBlockStatementNode(currentNode);

            if (isNonBlockLoopBody) {
                return true;
            }

            if (NodeGuards.isFunctionNode(parentNode) || NodeGuards.isProgramNode(parentNode)) {
                break;
            }

            currentNode = parentNode;
        }

        return false;
    }

    /**
     * @param {ObjectExpression} objectExpressionNode
     * @param {Statement} objectExpressionHostStatement
     * @returns {boolean}
     */
    private static isProhibitedEvaluationBoundary(
        objectExpressionNode: ESTree.ObjectExpression,
        objectExpressionHostStatement: ESTree.Statement
    ): boolean {
        let currentNode: ESTree.Node | undefined = objectExpressionNode.parentNode;

        while (currentNode) {
            if (NodeGuards.isFunctionNode(currentNode) || NodeGuards.isPropertyDefinitionNode(currentNode)) {
                return true;
            }

            if (currentNode === objectExpressionHostStatement) {
                break;
            }

            currentNode = currentNode.parentNode;
        }

        return false;
    }

    /**
     * Extraction hoists the object's properties into unconditionally-executed `host[key] = value`
     * statements in the host statement's scope. That is only safe when the object expression is
     * itself evaluated unconditionally whenever the host statement runs. When the object sits in a
     * short-circuit or conditional position — the right operand of `&&`/`||`/`??`, or a branch of
     * `?:` — the original evaluates it only conditionally; hoisting would evaluate it (and its
     * property values) every time, changing behavior. A real-world case is esbuild's dead
     * named-export marker `0 && (module.exports = { Foo })`, whose bare identifiers are never
     * evaluated originally but throw a `ReferenceError` once the object is hoisted and run
     * unconditionally.
     *
     * @param {ObjectExpression} objectExpressionNode
     * @param {Statement} objectExpressionHostStatement
     * @returns {boolean}
     */
    private static isProhibitedConditionalEvaluation(
        objectExpressionNode: ESTree.ObjectExpression,
        objectExpressionHostStatement: ESTree.Statement
    ): boolean {
        let currentNode: ESTree.Node = objectExpressionNode;

        while (currentNode !== objectExpressionHostStatement) {
            const parentNode: ESTree.Node | undefined = currentNode.parentNode;

            if (!parentNode) {
                break;
            }

            // The right operand of `&&`, `||`, `??` is only evaluated when the left operand does
            // not short-circuit, so it must not be hoisted into unconditional execution.
            if (NodeGuards.isLogicalExpressionNode(parentNode) && parentNode.right === currentNode) {
                return true;
            }

            // The `consequent`/`alternate` branches of `?:` are each evaluated only when the test
            // selects them, so they must not be hoisted into unconditional execution either.
            if (
                NodeGuards.isConditionalExpressionNode(parentNode) &&
                (parentNode.consequent === currentNode || parentNode.alternate === currentNode)
            ) {
                return true;
            }

            currentNode = parentNode;
        }

        return false;
    }

    /**
     * @param {ObjectExpression} objectExpressionNode
     * @returns {boolean}
     */
    private static isProhibitedSequenceExpression(objectExpressionNode: ESTree.ObjectExpression): boolean {
        const parentNode: ESTree.Node | undefined = objectExpressionNode.parentNode;

        if (!parentNode) {
            return false;
        }

        // Case 1: object is a direct child of a sequence expression
        // e.g. `return aux(ys), { min }`
        if (NodeGuards.isSequenceExpressionNode(parentNode)) {
            const index: number = parentNode.expressions.indexOf(objectExpressionNode);

            return index > 0;
        }

        // Case 2: object is nested inside a sequence expression via assignment/etc
        // e.g. `super(), this.state = { foo: 1 }`
        // Walk up to find if we're inside a sequence expression at a non-first position
        let currentNode: ESTree.Node = parentNode;

        while (currentNode.parentNode) {
            const currentParent: ESTree.Node = currentNode.parentNode;

            if (NodeGuards.isSequenceExpressionNode(currentParent)) {
                const index: number = currentParent.expressions.indexOf(<ESTree.Expression>currentNode);

                if (index > 0) {
                    // Only prohibit if earlier expressions contain calls (side effects)
                    return currentParent.expressions.slice(0, index).some(
                        (expr: ESTree.Expression) => {
                            let hasCall: boolean = false;

                            estraverse.traverse(expr, {
                                enter: (node: ESTree.Node) => {
                                    if (
                                        NodeGuards.isCallExpressionNode(node) ||
                                        NodeGuards.isNewExpressionNode(node)
                                    ) {
                                        hasCall = true;

                                        return estraverse.VisitorOption.Break;
                                    }
                                }
                            });

                            return hasCall;
                        }
                    );
                }

                return false;
            }

            if (
                NodeGuards.isFunctionNode(currentParent) ||
                NodeGuards.isProgramNode(currentParent) ||
                NodeGuards.isBlockStatementNode(currentParent)
            ) {
                break;
            }

            currentNode = currentParent;
        }

        return false;
    }

    /**
     * @param {NodeTransformationStage} nodeTransformationStage
     * @returns {IVisitor | null}
     */
    public getVisitor(nodeTransformationStage: NodeTransformationStage): IVisitor | null {
        if (!this.options.transformObjectKeys) {
            return null;
        }

        switch (nodeTransformationStage) {
            case NodeTransformationStage.Converting:
                return {
                    leave: (node: ESTree.Node, parentNode: ESTree.Node | null): ESTree.Node | undefined => {
                        if (parentNode && NodeGuards.isObjectExpressionNode(node)) {
                            return this.transformNode(node, parentNode);
                        }
                    }
                };

            default:
                return null;
        }
    }

    /**
     * replaces:
     *     var object = {
     *          foo: 1,
     *          bar: 2
     *     };
     *
     * on:
     *     var _0xabc123 = {};
     *     _0xabc123['foo'] = 1;
     *     _0xabc123['bar'] = 2;
     *     var object = _0xabc123;
     *
     * @param {ObjectExpression} objectExpressionNode
     * @param {Node} parentNode
     * @returns {NodeGuards}
     */
    public transformNode(objectExpressionNode: ESTree.ObjectExpression, parentNode: ESTree.Node): ESTree.Node {
        if (!objectExpressionNode.properties.length) {
            return objectExpressionNode;
        }

        const hostStatement: ESTree.Statement = NodeStatementUtils.getRootStatementOfNode(objectExpressionNode);

        if (
            ObjectExpressionKeysTransformer.isProhibitedObjectExpressionNode(objectExpressionNode, hostStatement)
        ) {
            return objectExpressionNode;
        }

        return this.applyObjectExpressionKeysExtractorsRecursive(objectExpressionNode, hostStatement, 0);
    }

    /**
     * @param {ObjectExpression} objectExpressionNode
     * @param {Statement} hostStatement
     * @param {number} extractorIndex
     * @returns {Node}
     */
    private applyObjectExpressionKeysExtractorsRecursive(
        objectExpressionNode: ESTree.ObjectExpression,
        hostStatement: ESTree.Statement,
        extractorIndex: number
    ): ESTree.Node {
        const objectExpressionExtractorNames = ObjectExpressionKeysTransformer.objectExpressionExtractorNames;

        if (extractorIndex >= objectExpressionExtractorNames.length) {
            return objectExpressionNode;
        }

        const objectExpressionExtractor: ObjectExpressionExtractor = objectExpressionExtractorNames[extractorIndex];

        const {
            nodeToReplace,
            objectExpressionHostStatement: newObjectExpressionHostStatement,
            objectExpressionNode: newObjectExpressionNode
        } = this.objectExpressionExtractorFactory(objectExpressionExtractor).extract(
            objectExpressionNode,
            hostStatement
        );

        this.applyObjectExpressionKeysExtractorsRecursive(
            newObjectExpressionNode,
            newObjectExpressionHostStatement,
            extractorIndex + 1
        );

        return nodeToReplace;
    }
}
