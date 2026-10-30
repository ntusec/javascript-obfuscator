import { inject, injectable, injectFromBase } from 'inversify';
import { ServiceIdentifiers } from '../../container/ServiceIdentifiers';

import * as ESTree from 'estree';

import { IOptions } from '../../interfaces/options/IOptions';
import { IRandomGenerator } from '../../interfaces/utils/IRandomGenerator';
import { IVisitor } from '../../interfaces/node-transformers/IVisitor';

import { NodeTransformationStage } from '../../enums/node-transformers/NodeTransformationStage';

import { AbstractNodeTransformer } from '../AbstractNodeTransformer';
import { NodeFactory } from '../../node/NodeFactory';
import { NodeGuards } from '../../node/NodeGuards';
import { NodeUtils } from '../../node/NodeUtils';

/**
 * Transform ES2015 template literals to ES5
 * Thanks to Babel for algorithm
 */
@injectFromBase()
@injectable()
export class TemplateLiteralTransformer extends AbstractNodeTransformer {
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
     * @param {NodeTransformationStage} nodeTransformationStage
     * @returns {IVisitor | null}
     */
    public getVisitor(nodeTransformationStage: NodeTransformationStage): IVisitor | null {
        switch (nodeTransformationStage) {
            case NodeTransformationStage.Converting:
                return {
                    enter: (node: ESTree.Node, parentNode: ESTree.Node | null): ESTree.Node | undefined => {
                        if (parentNode && NodeGuards.isTemplateLiteralNode(node)) {
                            return this.transformNode(node, parentNode);
                        }
                    }
                };

            default:
                return null;
        }
    }

    /**
     * @param {ESTree.TemplateLiteral} templateLiteralNode
     * @param {ESTree.Node} parentNode
     * @returns {ESTree.Node}
     */
    public transformNode(templateLiteralNode: ESTree.TemplateLiteral, parentNode: ESTree.Node): ESTree.Node {
        if (NodeGuards.isTaggedTemplateExpressionNode(parentNode)) {
            return templateLiteralNode;
        }

        return this.transformTemplateLiteralNode(templateLiteralNode, parentNode);
    }

    /**
     * @param {ESTree.TemplateLiteral} templateLiteralNode
     * @param {ESTree.Node} parentNode
     * @returns {ESTree.Expression}
     */
    private transformTemplateLiteralNode(
        templateLiteralNode: ESTree.TemplateLiteral,
        parentNode: ESTree.Node
    ): ESTree.Expression {
        const templateLiteralExpressions: ESTree.Expression[] = templateLiteralNode.expressions;

        const nodes: ESTree.Expression[] = [];

        const quasis: ESTree.TemplateElement[] = templateLiteralNode.quasis;
        const quasisLength: number = quasis.length;

        for (let i: number = 0; i < quasisLength; i++) {
            const templateElement: ESTree.TemplateElement = quasis[i];

            if (templateElement.value.cooked === undefined || templateElement.value.cooked === null) {
                continue;
            }

            nodes.push(NodeFactory.literalNode(templateElement.value.cooked));

            const expression: ESTree.Expression | undefined = templateLiteralExpressions[i];

            if (!expression) {
                continue;
            }

            nodes.push(expression);
        }

        const filteredNodes: ESTree.Expression[] = nodes.filter((node: ESTree.Literal | ESTree.Expression) => {
            return !(NodeGuards.isLiteralNode(node) && node.value === '');
        });

        let transformedNode: ESTree.Node;

        if (templateLiteralExpressions.length) {
            /**
             * A template literal coerces each interpolated expression with `ToString`
             * (a `ToPrimitive` call with the `"string"` hint, so `toString`/`Symbol.toPrimitive`
             * runs first). A `+` concatenation instead coerces objects with the `"default"` hint
             * (`valueOf` first), so `` `${obj}` `` and `'' + obj` can produce different strings.
             *
             * `String.prototype.concat` applies `ToString` to every argument with the `"string"`
             * hint, exactly matching template-literal semantics, so build `''.concat(...parts)`
             * instead of a `+` chain whenever there is at least one interpolation.
             */
            transformedNode = NodeFactory.callExpressionNode(
                NodeFactory.memberExpressionNode(
                    NodeFactory.literalNode(''),
                    NodeFactory.identifierNode('concat')
                ),
                filteredNodes
            );
        } else {
            // A template literal without interpolations is a constant string.
            transformedNode = filteredNodes.length ? filteredNodes[0] : NodeFactory.literalNode('');
        }

        NodeUtils.parentizeAst(transformedNode);
        NodeUtils.parentizeNode(transformedNode, parentNode);

        return transformedNode;
    }
}
